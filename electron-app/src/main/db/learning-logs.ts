import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

export interface LearningLog {
  id: string
  log_date: string
  time_slot: 'morning' | 'afternoon' | 'evening'
  task_id: string | null
  focus_minutes: number
  pomodoro_cycles: number
  interruption_count: number
  self_rating: number | null
  notes: string
  created_at: string
}

export interface DailyLogStats {
  date: string
  total_focus_minutes: number
  total_pomodoro_cycles: number
  total_interruptions: number
  avg_self_rating: number | null
}

export interface TimeSlotStats {
  time_slot: 'morning' | 'afternoon' | 'evening'
  total_focus_minutes: number
  avg_self_rating: number | null
  session_count: number
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

export function createLog(
  db: Database.Database,
  log: Omit<LearningLog, 'id' | 'created_at'>
): LearningLog {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO learning_logs (id, log_date, time_slot, task_id, focus_minutes,
      pomodoro_cycles, interruption_count, self_rating, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, log.log_date, log.time_slot, log.task_id,
    log.focus_minutes, log.pomodoro_cycles, log.interruption_count,
    log.self_rating, log.notes
  )
  return db.prepare('SELECT * FROM learning_logs WHERE id = ?').get(id) as LearningLog
}

export function getLogsByDateRange(
  db: Database.Database,
  from: string,
  to: string
): LearningLog[] {
  return db.prepare(`
    SELECT * FROM learning_logs
    WHERE log_date >= ? AND log_date <= ?
    ORDER BY log_date ASC, time_slot ASC
  `).all(from, to) as LearningLog[]
}

export function getLogsByDate(db: Database.Database, date: string): LearningLog[] {
  return db.prepare(`
    SELECT * FROM learning_logs
    WHERE log_date = ?
    ORDER BY time_slot ASC
  `).all(date) as LearningLog[]
}

export function getLogByDateAndSlot(
  db: Database.Database,
  date: string,
  timeSlot: 'morning' | 'afternoon' | 'evening'
): LearningLog | null {
  const row = db.prepare(`
    SELECT * FROM learning_logs
    WHERE log_date = ? AND time_slot = ?
    LIMIT 1
  `).get(date, timeSlot) as LearningLog | undefined
  return row ?? null
}

export function updateLog(
  db: Database.Database,
  id: string,
  changes: Partial<Omit<LearningLog, 'id' | 'created_at'>>
): LearningLog | null {
  const sets: string[] = []
  const args: unknown[] = []

  if (changes.log_date !== undefined) { sets.push('log_date = ?'); args.push(changes.log_date) }
  if (changes.time_slot !== undefined) { sets.push('time_slot = ?'); args.push(changes.time_slot) }
  if (changes.task_id !== undefined) { sets.push('task_id = ?'); args.push(changes.task_id) }
  if (changes.focus_minutes !== undefined) { sets.push('focus_minutes = ?'); args.push(changes.focus_minutes) }
  if (changes.pomodoro_cycles !== undefined) { sets.push('pomodoro_cycles = ?'); args.push(changes.pomodoro_cycles) }
  if (changes.interruption_count !== undefined) { sets.push('interruption_count = ?'); args.push(changes.interruption_count) }
  if (changes.self_rating !== undefined) { sets.push('self_rating = ?'); args.push(changes.self_rating) }
  if (changes.notes !== undefined) { sets.push('notes = ?'); args.push(changes.notes) }

  if (sets.length === 0) return getLogById(db, id)
  args.push(id)
  db.prepare(`UPDATE learning_logs SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  return getLogById(db, id)
}

export function deleteLog(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM learning_logs WHERE id = ?').run(id)
}

function getLogById(db: Database.Database, id: string): LearningLog | null {
  const row = db.prepare('SELECT * FROM learning_logs WHERE id = ?').get(id) as LearningLog | undefined
  return row ?? null
}

// ─── Aggregation ───────────────────────────────────────────────────────────────

export function getDailyStats(db: Database.Database, days: number = 30): DailyLogStats[] {
  return db.prepare(`
    SELECT log_date as date,
           SUM(focus_minutes) as total_focus_minutes,
           SUM(pomodoro_cycles) as total_pomodoro_cycles,
           SUM(interruption_count) as total_interruptions,
           AVG(self_rating) as avg_self_rating
    FROM learning_logs
    WHERE log_date >= date('now', ?)
    GROUP BY log_date
    ORDER BY log_date ASC
  `).all(`-${days} days`) as DailyLogStats[]
}

export function getTimeSlotStats(db: Database.Database, days: number = 30): TimeSlotStats[] {
  return db.prepare(`
    SELECT time_slot,
           SUM(focus_minutes) as total_focus_minutes,
           AVG(self_rating) as avg_self_rating,
           COUNT(*) as session_count
    FROM learning_logs
    WHERE log_date >= date('now', ?)
    GROUP BY time_slot
    ORDER BY total_focus_minutes DESC
  `).all(`-${days} days`) as TimeSlotStats[]
}

export function getLogSummary(
  db: Database.Database,
  days: number = 30
): { total_focus_minutes: number; total_pomodoros: number; avg_rating: number | null; total_logs: number } {
  const row = db.prepare(`
    SELECT COALESCE(SUM(focus_minutes), 0) as total_focus_minutes,
           COALESCE(SUM(pomodoro_cycles), 0) as total_pomodoros,
           AVG(self_rating) as avg_rating,
           COUNT(*) as total_logs
    FROM learning_logs
    WHERE log_date >= date('now', ?)
  `).get(`-${days} days`) as {
    total_focus_minutes: number
    total_pomodoros: number
    avg_rating: number | null
    total_logs: number
  }
  return row
}

// ─── Task link ─────────────────────────────────────────────────────────────────

export function getLogsByTaskId(db: Database.Database, taskId: string): LearningLog[] {
  return db.prepare(`
    SELECT * FROM learning_logs WHERE task_id = ?
    ORDER BY log_date DESC
  `).all(taskId) as LearningLog[]
}
