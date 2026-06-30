import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

export interface StudyPlan {
  id: string
  mode: 'normal' | 'sprint'
  exam_date: string
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface PlanTask {
  id: string
  plan_id: string
  date: string
  knowledge_tag: string
  suggested_count: number
  actual_count: number
  status: 'pending' | 'in_progress' | 'completed'
  completed_at: string | null
}

export interface CalendarDay {
  date: string
  total: number
  completed: number
}

export interface TagAccuracy {
  tag: string
  total: number
  correct: number
  rate: number
}

export interface PlanStats {
  today: { total: number; completed: number }
  streak: number
  totalStudyMs: number
  todayStudyMs: number
  tagAccuracy: TagAccuracy[]
}

export interface AdaptAdjustment {
  tag: string
  change: number
  reason: string
}

export interface StudySession {
  id: string
  plan_task_id: string | null
  type: 'manual' | 'pomodoro'
  started_at: string
  ended_at: string | null
  duration_ms: number | null
}

// 官方大纲知识点 (75 entries, each position = 1 day weight)
const NORMAL_SCHEDULE: Array<{ tag: string; count: number }> = [
  ...Array(5).fill(null).map(() => ({ tag: '计算机组成与体系结构', count: 15 })),
  ...Array(4).fill(null).map(() => ({ tag: '操作系统原理', count: 15 })),
  ...Array(5).fill(null).map(() => ({ tag: '数据库系统', count: 15 })),
  ...Array(4).fill(null).map(() => ({ tag: '计算机网络', count: 15 })),
  ...Array(6).fill(null).map(() => ({ tag: '软件工程基础', count: 15 })),
  ...Array(5).fill(null).map(() => ({ tag: '系统规划与分析', count: 15 })),
  ...Array(8).fill(null).map(() => ({ tag: '系统设计', count: 15 })),
  ...Array(10).fill(null).map(() => ({ tag: '软件架构设计', count: 20 })),
  ...Array(4).fill(null).map(() => ({ tag: '系统安全设计', count: 15 })),
  ...Array(4).fill(null).map(() => ({ tag: '系统可靠性', count: 15 })),
  ...Array(3).fill(null).map(() => ({ tag: '标准化与知识产权', count: 10 })),
  ...Array(10).fill(null).map(() => ({ tag: '案例分析专项', count: 3 })),
  ...Array(7).fill(null).map(() => ({ tag: '论文写作专项', count: 2 })),
]

// Sprint: focus on case/essay + key architecture topics
const SPRINT_SCHEDULE: Array<{ tag: string; count: number }> = [
  ...Array(10).fill(null).map(() => ({ tag: '案例分析专项', count: 3 })),
  ...Array(8).fill(null).map(() => ({ tag: '论文写作专项', count: 2 })),
  ...Array(6).fill(null).map(() => ({ tag: '软件架构设计', count: 20 })),
  ...Array(3).fill(null).map(() => ({ tag: '系统设计', count: 15 })),
  ...Array(3).fill(null).map(() => ({ tag: '数据库系统', count: 15 })),
]

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

// ─── Plan CRUD ────────────────────────────────────────────────────────────────

export function getActivePlan(db: Database.Database): StudyPlan | null {
  const row = db.prepare('SELECT * FROM study_plans ORDER BY created_at DESC LIMIT 1').get() as (StudyPlan & { config: string }) | undefined
  if (!row) return null
  return { ...row, config: JSON.parse(row.config) }
}

export function createPlan(
  db: Database.Database,
  examDate: string,
  mode: 'normal' | 'sprint',
  config: Record<string, unknown> = {}
): StudyPlan {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO study_plans (id, mode, exam_date, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, mode, examDate, JSON.stringify(config), now, now)

  generatePlanTasks(db, id, examDate, mode)

  return getActivePlan(db)!
}

export function deletePlan(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM study_plans WHERE id = ?').run(id)
}

export function generatePlanTasks(
  db: Database.Database,
  planId: string,
  examDate: string,
  mode: 'normal' | 'sprint'
): void {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const exam = new Date(examDate)
  exam.setHours(23, 59, 59, 0)
  const daysLeft = Math.max(1, Math.ceil((exam.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)))

  const isSprint = mode === 'sprint' || daysLeft <= 30
  const schedule = isSprint ? SPRINT_SCHEDULE : NORMAL_SCHEDULE

  const insert = db.prepare(
    'INSERT INTO plan_tasks (id, plan_id, date, knowledge_tag, suggested_count) VALUES (?, ?, ?, ?, ?)'
  )
  const insertAll = db.transaction(() => {
    for (let i = 0; i < daysLeft; i++) {
      const entry = schedule[i % schedule.length]
      const date = new Date(today)
      date.setDate(date.getDate() + i)
      insert.run(randomUUID(), planId, date.toISOString().slice(0, 10), entry.tag, entry.count)
    }
  })
  insertAll()
}

// ─── Task queries ─────────────────────────────────────────────────────────────

export function getPlanTasks(
  db: Database.Database,
  planId: string,
  dateFrom?: string,
  dateTo?: string
): PlanTask[] {
  let sql = 'SELECT * FROM plan_tasks WHERE plan_id = ?'
  const args: unknown[] = [planId]
  if (dateFrom) { sql += ' AND date >= ?'; args.push(dateFrom) }
  if (dateTo)   { sql += ' AND date <= ?'; args.push(dateTo) }
  sql += ' ORDER BY date ASC, knowledge_tag ASC'
  return db.prepare(sql).all(...args) as PlanTask[]
}

export function getTodayTasks(db: Database.Database, planId: string): PlanTask[] {
  return db.prepare(
    'SELECT * FROM plan_tasks WHERE plan_id = ? AND date = ? ORDER BY knowledge_tag ASC'
  ).all(planId, todayStr()) as PlanTask[]
}

export function updatePlanTask(
  db: Database.Database,
  taskId: string,
  changes: { status?: string; actual_count?: number }
): void {
  const sets: string[] = []
  const args: unknown[] = []

  if (changes.status !== undefined) {
    sets.push('status = ?')
    args.push(changes.status)
    if (changes.status === 'completed') {
      sets.push("completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
    }
  }
  if (changes.actual_count !== undefined) {
    sets.push('actual_count = ?')
    args.push(changes.actual_count)
  }
  if (sets.length === 0) return
  args.push(taskId)
  db.prepare(`UPDATE plan_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

export function getCalendar(
  db: Database.Database,
  planId: string,
  year: number,
  month: number
): CalendarDay[] {
  const from = `${year}-${String(month).padStart(2, '0')}-01`
  const to   = `${year}-${String(month).padStart(2, '0')}-31`
  return db.prepare(`
    SELECT date,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM plan_tasks
    WHERE plan_id = ? AND date >= ? AND date <= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(planId, from, to) as CalendarDay[]
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function calculateStreak(db: Database.Database, planId: string): number {
  const rows = db.prepare(`
    SELECT date,
           MAX(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as had_completion
    FROM plan_tasks
    WHERE plan_id = ?
    GROUP BY date
    ORDER BY date DESC
  `).all(planId) as Array<{ date: string; had_completion: number }>

  let streak = 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (const row of rows) {
    const d = new Date(row.date)
    d.setHours(0, 0, 0, 0)
    const diffDays = Math.round((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
    if (diffDays === streak && row.had_completion) {
      streak++
    } else if (diffDays > streak) {
      break
    }
  }
  return streak
}

export function getPlanStats(db: Database.Database, planId: string): PlanStats {
  const today = todayStr()

  const todayRow = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM plan_tasks WHERE plan_id = ? AND date = ?
  `).get(planId, today) as { total: number; completed: number }

  const streak = calculateStreak(db, planId)

  const totalMs = (db.prepare(`
    SELECT COALESCE(SUM(duration_ms), 0) as total_ms
    FROM study_sessions WHERE ended_at IS NOT NULL
  `).get() as { total_ms: number }).total_ms

  const todayMs = (db.prepare(`
    SELECT COALESCE(SUM(duration_ms), 0) as total_ms
    FROM study_sessions WHERE ended_at IS NOT NULL AND date(started_at) = ?
  `).get(today) as { total_ms: number }).total_ms

  // Per-tag accuracy from answer_records joined via json_each
  let tagAccuracy: TagAccuracy[] = []
  try {
    tagAccuracy = (db.prepare(`
      SELECT je.value as tag,
             COUNT(*) as total,
             SUM(CASE WHEN ar.is_correct = 1 THEN 1 ELSE 0 END) as correct
      FROM answer_records ar
      JOIN questions q ON ar.question_id = q.id
      JOIN json_each(q.knowledge_tags) je
      WHERE ar.is_correct IS NOT NULL
        AND ar.answered_at >= date('now', '-60 days')
      GROUP BY je.value
      HAVING COUNT(*) >= 3
      ORDER BY (SUM(CASE WHEN ar.is_correct = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*)) ASC
    `).all() as Array<{ tag: string; total: number; correct: number }>).map((r) => ({
      ...r,
      rate: r.total > 0 ? r.correct / r.total : 0,
    }))
  } catch { /* SQLite JSON functions not available */ }

  return {
    today: { total: todayRow.total ?? 0, completed: todayRow.completed ?? 0 },
    streak,
    totalStudyMs: totalMs,
    todayStudyMs: todayMs,
    tagAccuracy,
  }
}

// ─── Adaptive adjustment ──────────────────────────────────────────────────────

export function adaptPlan(
  db: Database.Database,
  planId: string
): { adjustments: AdaptAdjustment[] } {
  const today = todayStr()

  let tagStats: Array<{ tag: string; total: number; correct: number }> = []
  try {
    tagStats = db.prepare(`
      SELECT je.value as tag,
             COUNT(*) as total,
             SUM(CASE WHEN ar.is_correct = 1 THEN 1 ELSE 0 END) as correct
      FROM answer_records ar
      JOIN questions q ON ar.question_id = q.id
      JOIN json_each(q.knowledge_tags) je
      WHERE ar.is_correct IS NOT NULL
        AND ar.answered_at >= date('now', '-30 days')
      GROUP BY je.value
      HAVING COUNT(*) >= 5
    `).all() as Array<{ tag: string; total: number; correct: number }>
  } catch { return { adjustments: [] } }

  const adjustments: AdaptAdjustment[] = []

  for (const stat of tagStats) {
    const rate = stat.total > 0 ? stat.correct / stat.total : 0
    let change = 0
    let reason = ''

    if (rate < 0.6) {
      change = 5
      reason = `正确率 ${Math.round(rate * 100)}% 偏低，增加练习量`
    } else if (rate > 0.9) {
      change = -3
      reason = `正确率 ${Math.round(rate * 100)}% 较高，适当减少`
    }

    if (change !== 0) {
      db.prepare(`
        UPDATE plan_tasks
        SET suggested_count = MAX(2, suggested_count + ?)
        WHERE plan_id = ? AND date >= ? AND knowledge_tag = ?
      `).run(change, planId, today, stat.tag)
      adjustments.push({ tag: stat.tag, change, reason })
    }
  }

  return { adjustments }
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export function startSession(
  db: Database.Database,
  type: 'manual' | 'pomodoro' = 'manual',
  planTaskId?: string
): StudySession {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO study_sessions (id, plan_task_id, type) VALUES (?, ?, ?)'
  ).run(id, planTaskId ?? null, type)
  return db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(id) as StudySession
}

export function endSession(db: Database.Database, id: string, durationMs: number): void {
  db.prepare(`
    UPDATE study_sessions
    SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), duration_ms = ?
    WHERE id = ?
  `).run(durationMs, id)
}

export function getTodaySessions(db: Database.Database): StudySession[] {
  return db.prepare(
    "SELECT * FROM study_sessions WHERE date(started_at) = date('now') ORDER BY started_at ASC"
  ).all() as StudySession[]
}
