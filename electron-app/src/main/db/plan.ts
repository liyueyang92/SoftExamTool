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
  // Migration 19 extended fields
  task_type?: 'reading' | 'video' | 'practice' | 'review' | 'essay' | 'mock_exam' | 'custom'
  priority?: number
  estimated_min?: number
  actual_min?: number | null
  doc_id?: string | null
  doc_page_range?: string | null
  linked_doc_ids?: string
  linked_question_ids?: string
  linked_essay_id?: string | null
  locked?: number
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
  interruption_count?: number
  focus_rating?: number | null
}

export type PhaseType = 'foundation' | 'reinforcement' | 'sprint'

export interface PlanTemplate {
  id: string
  name: string
  description: string
  phase: PhaseType
  task_rules_json: string
  is_builtin: number
  created_at: string
}

export interface SprintStatus {
  isActive: boolean
  daysUntilExam: number | null
  dailyCardsReady: boolean
  essayDueToday: boolean
}

export interface SprintCardItem {
  tag: string
  keyPoints: string[]
  relatedErrorCount: number
}

export interface SprintCard {
  date: string
  items: SprintCardItem[]
  generatedAt: string
}

export interface FocusStats {
  totalSessions: number
  totalPomodoros: number
  avgFocusMinutes: number
  avgInterruptionsPerSession: number
  avgFocusRating: number | null
  bestTimeSlot: string
  dailyBreakdown: Array<{
    date: string
    focusMinutes: number
    pomodoros: number
    interruptions: number
  }>
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

/** Fisher-Yates shuffle (returns new array, does not mutate) */
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Weighted round-robin iterator that never repeats the same item consecutively
 * and reshuffles after each full traversal.
 */
function* weightedInterleaved<T extends { tag: string; count: number }>(
  items: T[],
  totalSlots: number,
  firstOnlyTags: Set<string> = new Set(),
): Generator<T, void, undefined> {
  if (items.length === 0) return
  // Build a weighted pool
  const pool: T[] = []
  for (const item of items) {
    const weight = firstOnlyTags.has(item.tag) ? 1 : item.count
    for (let i = 0; i < weight; i++) pool.push(item)
  }

  let lastTag = ''
  let yielded = 0
  let available = shuffleArray([...pool])

  while (yielded < totalSlots) {
    // Find next item with a different tag from last
    let chosenIdx = -1
    for (let i = 0; i < available.length; i++) {
      if (available[i].tag !== lastTag) {
        chosenIdx = i
        break
      }
    }
    // If all items have the same tag as last, pick any
    if (chosenIdx === -1) chosenIdx = 0

    const chosen = available.splice(chosenIdx, 1)[0]
    yield chosen
    lastTag = chosen.tag
    yielded++

    // Rebuild pool when exhausted
    if (available.length === 0) {
      available = shuffleArray([...pool])
      // Ensure first item of new pool != last tag
      if (available.length > 1 && available[0].tag === lastTag) {
        for (let i = 1; i < available.length; i++) {
          if (available[i].tag !== lastTag) {
            [available[0], available[i]] = [available[i], available[0]]
            break
          }
        }
      }
    }
  }
}

// ─── Tag alias map: old Python classifier names → plan schedule names ─────

/**
 * 标签别名映射。key 是旧版 Python 分类器可能产生的短标签名，
 * value 是对应的计划调度标签名。用于向后兼容已导入的旧文档。
 */
const TAG_ALIAS_MAP: Record<string, string[]> = {
  '计算机组成与体系结构': ['嵌入式系统', '计算机组成'],
  '操作系统原理': ['操作系统', '进程管理'],
  '数据库系统': ['数据库', 'nosql'],
  '计算机网络': ['网络与通信', '计算机网络', 'tcp/ip'],
  '软件工程基础': ['软件工程', '软件设计', '项目管理'],
  '系统设计': ['系统集成', '集成'],
  '软件架构设计': ['软件架构设计', '架构设计'],
  '系统安全设计': ['系统安全', '信息安全', '安全设计'],
  '系统可靠性': ['质量属性', '可靠性'],
  '案例分析专项': ['案例分析'],
  '论文写作专项': ['论文写作', '论文'],
}

// ─── Document → Knowledge Tag mapping helpers ────────────────────────────

/** 单个文档关联结果 */
interface DocMatch {
  doc_id: string
  page_range: string
  title: string
  chunk_count: number
  is_official: number
}

/**
 * 在已导入的文档库中查找与给定知识标签匹配的**全部**文档，
 * 官方教材始终排在最前面，其余按 chunk 数降序。
 *
 * 匹配策略（按优先级尝试每种关键词变体）：
 * 1. 精确匹配 plan schedule 标签名
 * 2. 别名匹配（兼容旧版 Python 分类器的短标签）
 * 3. 短名匹配（如"数据库系统"→"数据库"）
 */
function findDocsForTag(
  db: Database.Database,
  tag: string
): DocMatch[] {
  // 构建搜索变体列表
  const variants = new Set<string>([tag])
  for (const alias of (TAG_ALIAS_MAP[tag] ?? [])) {
    variants.add(alias)
  }
  const shortTag = tag.replace(/系统|基础|原理|设计|结构|专项/g, '').trim()
  if (shortTag.length >= 2 && shortTag !== tag) {
    variants.add(shortTag)
  }

  // 按优先级尝试每种变体，命中即用该变体的全部结果
  for (const variant of variants) {
    const rows = db.prepare(`
      SELECT d.id as doc_id,
             MIN(c.page_num) as first_page,
             MAX(c.page_num) as last_page,
             d.title,
             d.is_official,
             COUNT(*) as chunk_count
      FROM documents d
      JOIN doc_chunks c ON c.doc_id = d.id
      WHERE c.knowledge_tags LIKE ?
      GROUP BY d.id
      ORDER BY d.is_official DESC, COUNT(*) DESC
    `).all(`%${variant}%`) as Array<{
      doc_id: string; first_page: number; last_page: number;
      title: string; chunk_count: number; is_official: number
    }>

    if (rows.length > 0) {
      return rows.map((r) => ({
        doc_id: r.doc_id,
        page_range: r.first_page === r.last_page
          ? `${r.first_page}`
          : `${r.first_page}-${r.last_page}`,
        title: r.title,
        chunk_count: r.chunk_count,
        is_official: r.is_official,
      }))
    }
  }

  return []
}

/**
 * 为已有的 plan_tasks 批量重关联文档（存量计划修复）。
 * 遍历所有未关联文档的任务，调用 findDocForTag 尝试匹配。
 */
export function relinkPlanTasksToDocs(
  db: Database.Database,
  planId: string
): { scanned: number; linked: number } {
  const tasks = db.prepare(`
    SELECT id, knowledge_tag FROM plan_tasks
    WHERE plan_id = ? AND doc_id IS NULL AND task_type IN ('reading', 'practice', 'review')
  `).all(planId) as Array<{ id: string; knowledge_tag: string }>

  let linked = 0
  const updateStmt = db.prepare(`
    UPDATE plan_tasks SET doc_id = ?, doc_page_range = ?, linked_doc_ids = ? WHERE id = ?
  `)
  for (const task of tasks) {
    const allDocs = findDocsForTag(db, task.knowledge_tag)
    if (allDocs.length > 0) {
      const linkedDocIds = JSON.stringify(
        allDocs.map((d) => ({
          doc_id: d.doc_id,
          page_range: d.page_range,
          title: d.title,
          chunk_count: d.chunk_count,
          is_official: d.is_official,
        }))
      )
      updateStmt.run(allDocs[0].doc_id, allDocs[0].page_range, linkedDocIds, task.id)
      linked++
    }
  }

  return { scanned: tasks.length, linked }
}

/**
 * 批量更新 doc_chunks 中的旧版 knowledge_tags（短标签→长标签）。
 * 用于导入的旧文档重新映射标签，使后续匹配生效。
 */
export function remapDocChunkTags(
  db: Database.Database
): { total: number; updated: number } {
  const reverseMap: Record<string, string> = {}
  for (const [planTag, aliases] of Object.entries(TAG_ALIAS_MAP)) {
    for (const alias of aliases) {
      reverseMap[alias] = planTag
    }
  }

  let total = 0
  let updated = 0
  for (const [oldTag, newTag] of Object.entries(reverseMap)) {
    const rows = db.prepare(`
      SELECT id, knowledge_tags FROM doc_chunks WHERE knowledge_tags LIKE ?
    `).all(`%${oldTag}%`) as Array<{ id: string; knowledge_tags: string }>

    for (const row of rows) {
      total++
      try {
        const tags: string[] = JSON.parse(row.knowledge_tags)
        const updatedTags = tags.map((t) => (t === oldTag ? newTag : t))
        // Deduplicate
        const uniqueTags = [...new Set(updatedTags)]
        if (JSON.stringify(tags) !== JSON.stringify(uniqueTags)) {
          db.prepare(
            'UPDATE doc_chunks SET knowledge_tags = ? WHERE id = ?'
          ).run(JSON.stringify(uniqueTags), row.id)
          updated++
        }
      } catch {
        // 非 JSON 格式，跳过
      }
    }
  }

  return { total, updated }
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

  // Use phased plan for smarter progression (foundation → reinforcement → sprint)
  // Fallback to simple cycle schedule if knowledge_domains table is empty
  const domains = db.prepare(
    'SELECT id FROM knowledge_domains WHERE level = 3'
  ).all() as Array<{ id: string }>

  if (domains.length > 0) {
    generatePhasedPlan(db, id, examDate)
  } else {
    generatePlanTasks(db, id, examDate, mode)
  }

  return getActivePlan(db)!
}

export function deletePlan(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM study_plans WHERE id = ?').run(id)
}

/**
 * Apply AI-generated daily schedule to an existing plan.
 * Clears non-locked tasks first, then inserts the AI tasks.
 */
export function applyAiPlanSchedule(
  db: Database.Database,
  planId: string,
  dailySchedule: Array<{
    date: string
    phase?: string
    tasks: Array<{
      knowledge_tag: string
      task_type: string
      estimated_min: number
      suggested_count: number
      priority: number
      description?: string
    }>
  }>
): number {
  // Clear existing non-locked tasks
  db.prepare('DELETE FROM plan_tasks WHERE plan_id = ? AND locked = 0').run(planId)

  const insert = db.prepare(`
    INSERT INTO plan_tasks (id, plan_id, date, knowledge_tag, task_type,
      suggested_count, estimated_min, priority,
      doc_id, doc_page_range, linked_doc_ids, linked_question_ids, locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const docCache = new Map<string, DocMatch[]>()

  let count = 0
  const insertAll = db.transaction(() => {
    for (const day of dailySchedule) {
      for (const task of day.tasks) {
        const tag = task.knowledge_tag ?? ''
        const taskType = task.task_type ?? 'practice'

        // Auto-link documents for reading/practice tasks
        let docId: string | null = null
        let docPageRange: string | null = null
        let linkedDocIds = '[]'
        if (taskType === 'reading' || taskType === 'practice' || taskType === 'review') {
          if (!docCache.has(tag)) {
            docCache.set(tag, findDocsForTag(db, tag))
          }
          const allDocs = docCache.get(tag)!
          if (allDocs.length > 0) {
            docId = allDocs[0].doc_id
            docPageRange = allDocs[0].page_range
            linkedDocIds = JSON.stringify(
              allDocs.map((d) => ({
                doc_id: d.doc_id,
                page_range: d.page_range,
                title: d.title,
                chunk_count: d.chunk_count,
                is_official: d.is_official,
              }))
            )
          }
        }

        insert.run(
          randomUUID(), planId, day.date, tag, taskType,
          task.suggested_count ?? 0, task.estimated_min ?? 30,
          task.priority ?? 0,
          docId, docPageRange, linkedDocIds, '[]', 0,
        )
        count++
      }
    }
  })
  insertAll()

  return count
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

  // Build unique tag list from schedule (deduplicate)
  const rawSchedule = isSprint ? SPRINT_SCHEDULE : NORMAL_SCHEDULE
  const tagMap = new Map<string, { tag: string; count: number }>()
  for (const entry of rawSchedule) {
    const existing = tagMap.get(entry.tag)
    if (existing) {
      existing.count = Math.max(existing.count, entry.count)
    } else {
      tagMap.set(entry.tag, { tag: entry.tag, count: entry.count })
    }
  }
  const uniqueTags = Array.from(tagMap.values())

  // Tags that should not dominate (case study, essay — spread them out)
  const specialTags = new Set(['案例分析专项', '论文写作专项'])
  const domainTags = uniqueTags.filter((t) => !specialTags.has(t.tag))
  const essayTag = uniqueTags.find((t) => t.tag === '论文写作专项')
  const caseTag = uniqueTags.find((t) => t.tag === '案例分析专项')

  // Generator for knowledge domain tags (excludes specials)
  const domainGen = weightedInterleaved(
    domainTags.length > 0 ? domainTags : uniqueTags,
    daysLeft,
    specialTags,
  )

  const insert = db.prepare(`
    INSERT INTO plan_tasks (id, plan_id, date, knowledge_tag, task_type,
      suggested_count, estimated_min, priority, doc_id, doc_page_range,
      linked_doc_ids, linked_question_ids, locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const docCache = new Map<string, DocMatch[]>()

  function getDocForTag(tag: string): { docId: string | null; pageRange: string | null; linkedJson: string } {
    if (!docCache.has(tag)) {
      docCache.set(tag, findDocsForTag(db, tag))
    }
    const allDocs = docCache.get(tag)!
    if (allDocs.length === 0) return { docId: null, pageRange: null, linkedJson: '[]' }
    return {
      docId: allDocs[0].doc_id,
      pageRange: allDocs[0].page_range,
      linkedJson: JSON.stringify(allDocs.map((d) => ({
        doc_id: d.doc_id, page_range: d.page_range,
        title: d.title, chunk_count: d.chunk_count, is_official: d.is_official,
      }))),
    }
  }

  // Counters for periodic special tasks (avoid fixed-day modulo which causes overlap)
  let essayCounter = 0
  let caseCounter = 0
  const ESSAY_INTERVAL = isSprint ? 4 : 7    // sprint: essay every 4 days
  const CASE_INTERVAL = isSprint ? 3 : 5      // sprint: case study every 3 days
  const BUFFER_INTERVAL = 7                   // buffer/review day every 7 days

  const insertAll = db.transaction(() => {
    for (let d = 0; d < daysLeft; d++) {
      const date = new Date(today)
      date.setDate(date.getDate() + d)
      const dateStr = date.toISOString().slice(0, 10)
      const dayNum = d + 1

      // Weekly buffer day: light review of a random domain
      if (dayNum % BUFFER_INTERVAL === 0) {
        const tag = domainTags.length > 0
          ? domainTags[(d * 3) % domainTags.length].tag
          : uniqueTags[0].tag
        const doc = getDocForTag(tag)
        insert.run(randomUUID(), planId, dateStr, tag, 'review', 5, 30, 0,
          doc.docId, doc.pageRange, doc.linkedJson, '[]', 0)
        // Reset counters so buffer day doesn't consume essay/case slot
        essayCounter = 0
        caseCounter = 0
        continue
      }

      // Essay day: after accumulating enough non-buffer days
      essayCounter++
      if (essayTag && essayCounter >= ESSAY_INTERVAL) {
        insert.run(randomUUID(), planId, dateStr, essayTag.tag, 'essay', 1, 120, 2,
          null, null, '[]', '[]', 0)
        essayCounter = 0
        caseCounter++
        continue
      }

      // Case study day: after accumulating enough non-buffer/non-essay days
      caseCounter++
      if (caseTag && caseCounter >= CASE_INTERVAL) {
        insert.run(randomUUID(), planId, dateStr, caseTag.tag, 'review', caseTag.count, 60, 1,
          null, null, '[]', '[]', 0)
        caseCounter = 0
        continue
      }

      // Normal domain day: reading + practice pair
      const domain = domainGen.next().value
      if (!domain) continue
      const doc = getDocForTag(domain.tag)

      // Reading task
      const readingMin = Math.min(90, domain.count * 4)
      insert.run(randomUUID(), planId, dateStr, domain.tag, 'reading', 0, readingMin, 0,
        doc.docId, doc.pageRange, doc.linkedJson, '[]', 0)

      // Practice task
      const practiceMin = Math.min(60, domain.count * 2)
      insert.run(randomUUID(), planId, dateStr, domain.tag, 'practice', domain.count, practiceMin, 0,
        null, null, '[]', '[]', 0)
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

export function getTodaySessions(db: Database.Database): StudySession[] {
  return db.prepare(
    "SELECT * FROM study_sessions WHERE date(started_at) = date('now') ORDER BY started_at ASC"
  ).all() as StudySession[]
}

// ─── Enhanced endSession (Phase 2 + 5) ─────────────────────────────────────────

export function endSession(
  db: Database.Database,
  id: string,
  durationMs: number,
  interruptionCount?: number,
  focusRating?: number
): void {
  const sets = [
    "ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    'duration_ms = ?',
  ]
  const args: unknown[] = [durationMs]

  if (interruptionCount !== undefined) {
    sets.push('interruption_count = ?')
    args.push(interruptionCount)
  }
  if (focusRating !== undefined) {
    sets.push('focus_rating = ?')
    args.push(focusRating)
  }
  args.push(id)
  db.prepare(`UPDATE study_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

// ─── Three-stage plan generation ───────────────────────────────────────────────

export function generatePhasedPlan(
  db: Database.Database,
  planId: string,
  examDate: string
): { tasksCreated: number } {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const exam = new Date(examDate)
  exam.setHours(23, 59, 59, 0)
  const totalDays = Math.max(7, Math.ceil((exam.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)))

  // Phase boundaries
  const foundationDays = Math.floor(totalDays * 0.60)
  const reinforcementDays = Math.floor(totalDays * 0.30)
  const sprintDays = totalDays - foundationDays - reinforcementDays

  // Get domain data
  const domains = db.prepare(
    'SELECT * FROM knowledge_domains WHERE level = 3 ORDER BY level ASC, sort_order ASC'
  ).all() as Array<{
    id: string; parent_id: string; name: string; level: number
    sort_order: number; suggested_min: number; weight_pct: number
    is_required: number
  }>

  // Get exam config for daily limits
  let dailyMaxMin = 180
  try {
    const config = db.prepare(
      "SELECT * FROM exam_config WHERE id = 'singleton'"
    ).get() as { daily_max_minutes: number } | undefined
    if (config) dailyMaxMin = config.daily_max_minutes
  } catch { /* config table might not exist yet */ }

  const insert = db.prepare(`
    INSERT INTO plan_tasks (id, plan_id, date, knowledge_tag, task_type,
      suggested_count, estimated_min, priority, doc_id, doc_page_range,
      linked_doc_ids, locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let taskCount = 0

  // Cache for document lookups
  const docCache = new Map<string, DocMatch[]>()

  const createTask = (
    d: string, tag: string, type: string, estMin: number,
    suggestedCount: number, priority: number,
    docId: string | null = null,
    docPageRange: string | null = null,
    linkedDocIds: string = '[]',
  ) => {
    insert.run(randomUUID(), planId, d, tag, type, suggestedCount, estMin, priority,
      docId, docPageRange, linkedDocIds, 0)
    taskCount++
  }

  const generateAll = db.transaction(() => {
    let cursor = new Date(today)
    const domainCount = domains.length

    // Helper: link docs for a domain tag
    function linkDocsForDomain(domainName: string): { docId: string | null; pageRange: string | null; linkedJson: string } {
      if (!docCache.has(domainName)) {
        docCache.set(domainName, findDocsForTag(db, domainName))
      }
      const allDocs = docCache.get(domainName)!
      if (allDocs.length === 0) return { docId: null, pageRange: null, linkedJson: '[]' }
      return {
        docId: allDocs[0].doc_id,
        pageRange: allDocs[0].page_range,
        linkedJson: JSON.stringify(allDocs.map((dr) => ({
          doc_id: dr.doc_id, page_range: dr.page_range,
          title: dr.title, chunk_count: dr.chunk_count, is_official: dr.is_official,
        }))),
      }
    }

    // ── Stage 1: Foundation (sequential, ordered pass through all domains) ──────
    if (domainCount === 0) return
    for (let d = 0; d < foundationDays; d++) {
      const dateStr = cursor.toISOString().slice(0, 10)

      // Weekly buffer day (every 7th day): light review, no new material
      if ((d + 1) % 7 === 0) {
        const bufDomain = domains[d % domainCount]
        createTask(dateStr, bufDomain.name, 'review', 30, 5, 0)
        cursor.setDate(cursor.getDate() + 1)
        continue
      }

      // Sequential: walk through domains in natural order, wrapping when done
      const domain = domains[d % domainCount]
      const { docId, pageRange, linkedJson } = linkDocsForDomain(domain.name)

      // Reading task (~60% of daily time)
      const readingMin = Math.min(Math.round(domain.suggested_min * 0.6), Math.floor(dailyMaxMin * 0.6))
      createTask(dateStr, domain.name, 'reading', readingMin, 0, 0, docId, pageRange, linkedJson)

      // Practice task (~40% of daily time)
      const practiceMin = Math.min(Math.round(domain.suggested_min * 0.4), dailyMaxMin - readingMin)
      createTask(dateStr, domain.name, 'practice', practiceMin, 15, 0)

      cursor.setDate(cursor.getDate() + 1)
    }

    // ── Stage 2: Reinforcement (multiple rounds, practice-focused) ───────────────
    let essayCounter = 0
    let caseCounter = 0
    const ESSAY_GAP = 7
    const CASE_GAP = 3
    for (let d = 0; d < reinforcementDays; d++) {
      const dateStr = cursor.toISOString().slice(0, 10)

      const domain = domains[d % domainCount]  // sequential, wraps naturally
      createTask(dateStr, domain.name, 'practice', 45, 10, 1)

      // Case study periodically
      caseCounter++
      if (caseCounter >= CASE_GAP) {
        createTask(dateStr, '案例分析专项', 'review', 60, 3, 2)
        caseCounter = 0
      }

      // Essay periodically
      essayCounter++
      if (essayCounter >= ESSAY_GAP) {
        createTask(dateStr, '论文写作专项', 'essay', 120, 1, 2)
        essayCounter = 0
      }

      cursor.setDate(cursor.getDate() + 1)
    }

    // ── Stage 3: Sprint (multiple rounds of mock exams + targeted review) ────────
    // Cycle through: mock_exam → review → domain_practice, repeat
    for (let d = 0; d < sprintDays; d++) {
      const dateStr = cursor.toISOString().slice(0, 10)
      const posInCycle = d % 3

      if (posInCycle === 0) {
        // Mock exam day: full-length test
        createTask(dateStr, '综合知识', 'mock_exam', 180, 75, 3)
      } else if (posInCycle === 1) {
        // Review day: go over wrong answers from mock
        createTask(dateStr, '错题回顾', 'review', 90, 0, 3)
      } else {
        // Targeted practice: cycle through domains
        const domain = domains[d % domainCount]
        createTask(dateStr, domain.name, 'practice', 45, 15, 2)
      }

      cursor.setDate(cursor.getDate() + 1)
    }
  })

  generateAll()

  return { tasksCreated: taskCount }
}

// ─── Dynamic adjustment: speed-aware ──────────────────────────────────────────

export function checkPaceAndAdjust(
  db: Database.Database,
  planId: string
): { adjustments: AdaptAdjustment[]; warning: boolean } {
  const adjustments: AdaptAdjustment[] = []
  let warning = false

  // Get last 3 days of learning logs
  const recentLogs = db.prepare(`
    SELECT log_date, SUM(focus_minutes) as total_min
    FROM learning_logs
    WHERE log_date >= date('now', '-3 days')
    GROUP BY log_date
    ORDER BY log_date DESC
  `).all() as Array<{ log_date: string; total_min: number }>

  if (recentLogs.length < 2) return { adjustments, warning }

  for (const dayLog of recentLogs) {
    const plannedMin = (db.prepare(`
      SELECT COALESCE(SUM(estimated_min), 0) as total
      FROM plan_tasks WHERE plan_id = ? AND date = ?
    `).get(planId, dayLog.log_date) as { total: number }).total

    if (plannedMin === 0) continue

    const ratio = dayLog.total_min / plannedMin

    if (ratio < 0.7) {
      // Lagging: compress low-priority future tasks
      const futureTasks = db.prepare(`
        SELECT id, estimated_min, linked_question_ids
        FROM plan_tasks
        WHERE plan_id = ? AND date > ? AND priority < 2 AND locked = 0 AND task_type = 'practice'
      `).all(planId, dayLog.log_date) as Array<{
        id: string; estimated_min: number; linked_question_ids: string
      }>

      for (const task of futureTasks) {
        const newEstMin = Math.max(15, Math.round(task.estimated_min * 0.7))
        let questionIds = '[]'
        try { questionIds = JSON.parse(task.linked_question_ids).slice(0, 8) } catch { /* keep as-is */ }
        db.prepare(
          'UPDATE plan_tasks SET estimated_min = ?, linked_question_ids = ? WHERE id = ?'
        ).run(newEstMin, JSON.stringify(questionIds), task.id)
      }
      warning = true
      adjustments.push({
        tag: dayLog.log_date,
        change: -Math.round((1 - ratio) * 100),
        reason: `实际学习时长仅为计划的${Math.round(ratio * 100)}%，已压缩低优先级任务`,
      })
    } else if (ratio > 1.2) {
      adjustments.push({
        tag: dayLog.log_date,
        change: 0,
        reason: '学习进度超前，可提前进入下一阶段或生成拓展阅读',
      })
    }
  }

  return { adjustments, warning }
}

// ─── Skip day: distribute incomplete tasks ─────────────────────────────────────

export function distributeSkippedTasks(
  db: Database.Database,
  planId: string,
  skipDate: string
): { distributed: number } {
  const incomplete = db.prepare(`
    SELECT id FROM plan_tasks
    WHERE plan_id = ? AND date = ? AND status != 'completed'
    ORDER BY priority DESC
  `).all(planId, skipDate) as { id: string }[]

  if (incomplete.length === 0) return { distributed: 0 }

  const next3Days: string[] = []
  const d = new Date(skipDate)
  for (let i = 1; i <= 3; i++) {
    d.setDate(d.getDate() + 1)
    next3Days.push(d.toISOString().slice(0, 10))
  }

  let count = 0
  for (let j = 0; j < incomplete.length; j++) {
    const targetDate = next3Days[j % 3]
    db.prepare('UPDATE plan_tasks SET date = ? WHERE id = ?').run(targetDate, incomplete[j].id)
    count++
  }

  return { distributed: count }
}

// ─── Lock / Unlock ─────────────────────────────────────────────────────────────

export function lockDays(
  db: Database.Database,
  planId: string,
  fromDate: string,
  toDate: string
): { locked: number } {
  const info = db.prepare(`
    UPDATE plan_tasks SET locked = 1
    WHERE plan_id = ? AND date >= ? AND date <= ?
  `).run(planId, fromDate, toDate)
  return { locked: info.changes }
}

export function unlockDays(
  db: Database.Database,
  planId: string,
  fromDate: string,
  toDate: string
): { unlocked: number } {
  const info = db.prepare(`
    UPDATE plan_tasks SET locked = 0
    WHERE plan_id = ? AND date >= ? AND date <= ?
  `).run(planId, fromDate, toDate)
  return { unlocked: info.changes }
}

// ─── Custom task & move ────────────────────────────────────────────────────────

export function addCustomTask(
  db: Database.Database,
  planId: string,
  task: {
    date: string; knowledge_tag: string; task_type: string
    estimated_min: number; suggested_count: number; priority: number
    linked_question_ids?: string
    doc_id?: string | null
    doc_page_range?: string | null
    linked_doc_ids?: string
  }
): PlanTask {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO plan_tasks (id, plan_id, date, knowledge_tag, task_type,
      suggested_count, estimated_min, priority, linked_question_ids,
      doc_id, doc_page_range, linked_doc_ids, locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id, planId, task.date, task.knowledge_tag, task.task_type,
    task.suggested_count, task.estimated_min, task.priority,
    task.linked_question_ids ?? '[]',
    task.doc_id ?? null, task.doc_page_range ?? null,
    task.linked_doc_ids ?? '[]',
  )
  return db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(id) as PlanTask
}

export function moveTask(
  db: Database.Database,
  taskId: string,
  newDate: string
): void {
  db.prepare('UPDATE plan_tasks SET date = ? WHERE id = ?').run(newDate, taskId)
}

export function resetPlan(
  db: Database.Database,
  planId: string,
  keepLogs: boolean = true
): void {
  // Delete all tasks for this plan
  db.prepare('DELETE FROM plan_tasks WHERE plan_id = ?').run(planId)

  // Optionally clear related learning logs
  if (!keepLogs) {
    db.prepare(`
      DELETE FROM learning_logs WHERE task_id IN (
        SELECT id FROM plan_tasks WHERE plan_id = ?
      )
    `).run(planId)
  }
}

// ─── Plan templates ────────────────────────────────────────────────────────────

export function listTemplates(db: Database.Database): PlanTemplate[] {
  return db.prepare(
    'SELECT * FROM plan_templates ORDER BY is_builtin DESC, created_at DESC'
  ).all() as PlanTemplate[]
}

export function createTemplate(
  db: Database.Database,
  template: Omit<PlanTemplate, 'id' | 'created_at'>
): PlanTemplate {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO plan_templates (id, name, description, phase, task_rules_json, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, template.name, template.description, template.phase,
    template.task_rules_json, template.is_builtin)
  return db.prepare('SELECT * FROM plan_templates WHERE id = ?').get(id) as PlanTemplate
}

export function deleteTemplate(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM plan_templates WHERE id = ? AND is_builtin = 0').run(id)
}

export function applyTemplate(
  db: Database.Database,
  planId: string,
  templateId: string
): { tasksCreated: number } {
  const template = db.prepare(
    'SELECT * FROM plan_templates WHERE id = ?'
  ).get(templateId) as PlanTemplate | undefined
  if (!template) throw new Error('Template not found')

  // Delete existing non-locked tasks
  db.prepare(
    'DELETE FROM plan_tasks WHERE plan_id = ? AND locked = 0'
  ).run(planId)

  let rules: Record<string, unknown> = {}
  try { rules = JSON.parse(template.task_rules_json) } catch { /* use empty */ }

  const insert = db.prepare(`
    INSERT INTO plan_tasks (id, plan_id, date, knowledge_tag, task_type,
      suggested_count, estimated_min, priority, locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `)

  const count = db.transaction(() => {
    let n = 0
    const dailyTasks = (rules.daily_tasks as Array<Record<string, unknown>>) ?? []
    const today = new Date()
    for (let i = 0; i < dailyTasks.length; i++) {
      const t = dailyTasks[i]
      const d = new Date(today)
      d.setDate(d.getDate() + i)
      insert.run(
        randomUUID(), planId, d.toISOString().slice(0, 10),
        (t.tag as string) ?? '', (t.type as string) ?? 'practice',
        (t.count as number) ?? 10, (t.estimated_min as number) ?? 30,
        (t.priority as number) ?? 0
      )
      n++
    }
    return n
  })()

  return { tasksCreated: count }
}

// ─── Sprint mode ───────────────────────────────────────────────────────────────

export function getSprintStatus(db: Database.Database): SprintStatus {
  const plan = getActivePlan(db)
  if (!plan) {
    return { isActive: false, daysUntilExam: null, dailyCardsReady: false, essayDueToday: false }
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const exam = new Date(plan.exam_date)
  exam.setHours(23, 59, 59, 0)
  const daysLeft = Math.max(0, Math.ceil((exam.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)))
  const isActive = plan.mode === 'sprint' || daysLeft <= 30

  const essayToday = isActive
    ? ((db.prepare(`
        SELECT COUNT(*) as cnt FROM plan_tasks
        WHERE plan_id = ? AND date = ? AND task_type = 'essay'
      `).get(plan.id, today.toISOString().slice(0, 10)) as { cnt: number }).cnt > 0)
    : false

  return {
    isActive,
    daysUntilExam: daysLeft,
    dailyCardsReady: false,
    essayDueToday: essayToday,
  }
}

export function activateSprintMode(db: Database.Database, planId: string): void {
  db.prepare("UPDATE study_plans SET mode = 'sprint', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), planId)
}

export function generateDailyTopCards(db: Database.Database): SprintCard {
  const today = todayStr()

  // Get tag accuracy data
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
        AND ar.answered_at >= date('now', '-60 days')
      GROUP BY je.value
      HAVING COUNT(*) >= 3
    `).all() as Array<{ tag: string; total: number; correct: number }>
  } catch { /* JSON functions unavailable */ }

  // Score each tag: error_rate * 0.4 + (1 - mastery) * 0.25, then sort
  const scored = tagStats.map((s) => {
    const errorRate = s.total > 0 ? 1 - s.correct / s.total : 0.5
    const mastery = s.total > 0 ? s.correct / s.total : 0
    const score = errorRate * 0.65 + (1 - mastery) * 0.35
    return { tag: s.tag, score, errorCount: s.total - s.correct }
  })

  scored.sort((a, b) => b.score - a.score)
  const top10 = scored.slice(0, 10)

  const items: SprintCardItem[] = top10.map((s) => ({
    tag: s.tag,
    keyPoints: [],
    relatedErrorCount: s.errorCount,
  }))

  return { date: today, items, generatedAt: new Date().toISOString() }
}

// ─── Focus stats ───────────────────────────────────────────────────────────────

export function getFocusStats(db: Database.Database, days: number = 30): FocusStats {
  const rows = db.prepare(`
    SELECT date(started_at) as date,
           COUNT(*) as sessions,
           SUM(CASE WHEN type = 'pomodoro' THEN 1 ELSE 0 END) as pomodoros,
           SUM(CASE WHEN duration_ms IS NOT NULL THEN duration_ms / 60000.0 ELSE 0 END) as focus_minutes,
           SUM(COALESCE(interruption_count, 0)) as interruptions,
           AVG(focus_rating) as avg_rating
    FROM study_sessions
    WHERE started_at >= date('now', ?)
      AND ended_at IS NOT NULL
    GROUP BY date(started_at)
    ORDER BY date ASC
  `).all(`-${days} days`) as Array<{
    date: string; sessions: number; pomodoros: number
    focus_minutes: number; interruptions: number; avg_rating: number | null
  }>

  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0)
  const totalPomodoros = rows.reduce((s, r) => s + r.pomodoros, 0)
  const totalFocus = rows.reduce((s, r) => s + r.focus_minutes, 0)
  const totalInterruptions = rows.reduce((s, r) => s + r.interruptions, 0)
  const allRatings = rows.filter((r) => r.avg_rating != null).map((r) => r.avg_rating!)
  const avgRating = allRatings.length > 0
    ? allRatings.reduce((s, v) => s + v, 0) / allRatings.length
    : null

  // Best time slot from learning_logs
  let bestTimeSlot = 'evening'
  try {
    const slotRow = db.prepare(`
      SELECT time_slot, SUM(focus_minutes) as total
      FROM learning_logs
      WHERE log_date >= date('now', ?)
      GROUP BY time_slot
      ORDER BY total DESC
      LIMIT 1
    `).get(`-${days} days`) as { time_slot: string } | undefined
    if (slotRow) bestTimeSlot = slotRow.time_slot
  } catch { /* logs table might not exist */ }

  return {
    totalSessions,
    totalPomodoros,
    avgFocusMinutes: totalSessions > 0 ? Math.round(totalFocus / totalSessions) : 0,
    avgInterruptionsPerSession: totalSessions > 0
      ? Math.round((totalInterruptions / totalSessions) * 10) / 10
      : 0,
    avgFocusRating: avgRating ? Math.round(avgRating * 10) / 10 : null,
    bestTimeSlot,
    dailyBreakdown: rows.map((r) => ({
      date: r.date,
      focusMinutes: Math.round(r.focus_minutes),
      pomodoros: r.pomodoros,
      interruptions: r.interruptions,
    })),
  }
}
