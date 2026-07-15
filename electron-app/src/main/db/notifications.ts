import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

export interface Notification {
  id: string
  type: 'daily_plan' | 'progress_warning' | 'streak_milestone' | 'countdown' | 'pomodoro_end' | 'achievement' | 'system'
  title: string
  body: string
  action_url: string | null
  is_read: number
  created_at: string
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

export function createNotification(
  db: Database.Database,
  n: Omit<Notification, 'id' | 'is_read' | 'created_at'>
): Notification {
  // Prevent duplicate notifications of same type on same day
  const existing = db.prepare(`
    SELECT id FROM notifications
    WHERE type = ? AND date(created_at) = date('now')
    LIMIT 1
  `).get(n.type) as { id: string } | undefined

  if (existing && (n.type === 'daily_plan' || n.type === 'streak_milestone')) {
    // Update instead of create duplicate
    db.prepare(`
      UPDATE notifications SET title = ?, body = ?, action_url = ?, is_read = 0
      WHERE id = ?
    `).run(n.title, n.body, n.action_url, existing.id)
    return db.prepare('SELECT * FROM notifications WHERE id = ?').get(existing.id) as Notification
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO notifications (id, type, title, body, action_url)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, n.type, n.title, n.body, n.action_url ?? null)
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Notification
}

export function listNotifications(
  db: Database.Database,
  isRead?: number,
  limit: number = 50
): Notification[] {
  let sql = 'SELECT * FROM notifications'
  const args: unknown[] = []
  if (isRead !== undefined) {
    sql += ' WHERE is_read = ?'
    args.push(isRead)
  }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  args.push(limit)
  return db.prepare(sql).all(...args) as Notification[]
}

export function markRead(db: Database.Database, id: string): void {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(id)
}

export function markAllRead(db: Database.Database): void {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run()
}

export function getUnreadCount(db: Database.Database): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM notifications WHERE is_read = 0'
  ).get() as { cnt: number }
  return row.cnt
}

export function deleteOldNotifications(db: Database.Database, daysOld: number = 90): number {
  const info = db.prepare(
    `DELETE FROM notifications WHERE created_at < date('now', ?)`
  ).run(`-${daysOld} days`)
  return info.changes
}

// ─── Trigger checks ────────────────────────────────────────────────────────────

export interface CheckResult {
  notifications: Notification[]
}

export function checkNotificationTriggers(db: Database.Database): Notification[] {
  const newNotifications: Notification[] = []

  // 1. Daily plan notification
  try {
    const config = db.prepare(
      "SELECT * FROM exam_config WHERE id = 'singleton'"
    ).get() as { study_start_time: string; exam_date: string | null } | undefined

    if (config) {
      const now = new Date()
      const [h, m] = config.study_start_time.split(':').map(Number)
      const startMin = h * 60 + m
      const nowMin = now.getHours() * 60 + now.getMinutes()
      const diffMin = Math.abs(nowMin - startMin)

      // Within 60 minutes of study start time
      if (diffMin <= 60) {
        const plan = db.prepare(
          'SELECT id FROM study_plans ORDER BY created_at DESC LIMIT 1'
        ).get() as { id: string } | undefined

        if (plan) {
          const today = new Date().toISOString().slice(0, 10)
          const tasks = db.prepare(`
            SELECT COUNT(*) as cnt, COALESCE(SUM(estimated_min), 0) as total_min
            FROM plan_tasks WHERE plan_id = ? AND date = ?
          `).get(plan.id, today) as { cnt: number; total_min: number }

          if (tasks.cnt > 0) {
            const n = createNotification(db, {
              type: 'daily_plan',
              title: '今日学习计划',
              body: `共 ${tasks.cnt} 项任务，预计 ${tasks.total_min} 分钟`,
              action_url: '/plans',
            })
            newNotifications.push(n)
          }
        }
      }
    }
  } catch { /* config table may not exist */ }

  // 2. Progress lag warning (consecutive 2 days completion < 70%)
  try {
    const last2Days: string[] = []
    const d = new Date()
    for (let i = 0; i < 2; i++) {
      d.setDate(d.getDate() - 1)
      last2Days.push(d.toISOString().slice(0, 10))
    }

    let allLow = true
    for (const day of last2Days) {
      const stats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
        FROM plan_tasks WHERE date = ?
      `).get(day) as { total: number; completed: number }

      if (stats.total === 0) { allLow = false; break }
      if (stats.completed / stats.total >= 0.7) { allLow = false; break }
    }

    if (allLow) {
      const n = createNotification(db, {
        type: 'progress_warning',
        title: '进度滞后提醒',
        body: '连续 2 天未完成 70% 计划任务，建议调整计划或利用弹性日补漏',
        action_url: '/plans',
      })
      newNotifications.push(n)
    }
  } catch { /* plan_tasks may not have data */ }

  // 3. Streak milestones
  try {
    const rows = db.prepare(`
      SELECT DISTINCT date(completed_at) as d
      FROM plan_tasks
      WHERE status = 'completed' AND completed_at IS NOT NULL
      ORDER BY d DESC
      LIMIT 31
    `).all() as { d: string }[]

    let streak = 0
    const today = new Date().toISOString().slice(0, 10)
    let expected = today

    for (const { d } of rows) {
      if (d === expected) {
        streak++
        const prev = new Date(expected)
        prev.setDate(prev.getDate() - 1)
        expected = prev.toISOString().slice(0, 10)
      } else {
        break
      }
    }

    const milestones = [3, 7, 21, 30]
    if (milestones.includes(streak)) {
      const messages: Record<number, string> = {
        3: '坚持就是胜利！继续保持！',
        7: '一周连续学习，好习惯正在养成！',
        21: '21天养成好习惯，你做到了！',
        30: '连续学习一个月，自律给你自由！',
      }
      const n = createNotification(db, {
        type: 'streak_milestone',
        title: `连续学习 ${streak} 天！`,
        body: messages[streak] ?? '了不起的成就！',
        action_url: '/achievements',
      })
      newNotifications.push(n)
    }
  } catch { /* ignore */ }

  // 4. Exam countdown
  try {
    const config = db.prepare(
      "SELECT * FROM exam_config WHERE id = 'singleton'"
    ).get() as { exam_date: string | null } | undefined

    if (config && config.exam_date) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const exam = new Date(config.exam_date)
      exam.setHours(23, 59, 59, 0)
      const daysLeft = Math.max(0, Math.ceil((exam.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)))

      const checkpoints = [30, 14, 7, 3, 1]
      if (checkpoints.includes(daysLeft)) {
        const n = createNotification(db, {
          type: 'countdown',
          title: `距考试还有 ${daysLeft} 天`,
          body: daysLeft <= 7
            ? '最后冲刺阶段，保持节奏，注意休息！'
            : '合理安排复习计划，稳扎稳打',
          action_url: '/plans',
        })
        newNotifications.push(n)
      }
    }
  } catch { /* ignore */ }

  return newNotifications
}
