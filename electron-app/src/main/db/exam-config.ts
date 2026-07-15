import Database from 'better-sqlite3-multiple-ciphers'

export interface ExamConfig {
  id: string
  exam_name: string
  exam_date: string | null
  syllabus_version: string
  target_score: number
  daily_min_minutes: number
  daily_max_minutes: number
  study_start_time: string
  created_at: string
  updated_at: string
}

export function getExamConfig(db: Database.Database): ExamConfig | null {
  const row = db.prepare(
    "SELECT * FROM exam_config WHERE id = 'singleton'"
  ).get() as ExamConfig | undefined
  return row ?? null
}

export function saveExamConfig(
  db: Database.Database,
  config: Omit<ExamConfig, 'id' | 'created_at' | 'updated_at'>
): ExamConfig {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO exam_config (id, exam_name, exam_date, syllabus_version, target_score,
      daily_min_minutes, daily_max_minutes, study_start_time, updated_at)
    VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      exam_name = excluded.exam_name,
      exam_date = excluded.exam_date,
      syllabus_version = excluded.syllabus_version,
      target_score = excluded.target_score,
      daily_min_minutes = excluded.daily_min_minutes,
      daily_max_minutes = excluded.daily_max_minutes,
      study_start_time = excluded.study_start_time,
      updated_at = excluded.updated_at
  `).run(
    config.exam_name, config.exam_date, config.syllabus_version,
    config.target_score, config.daily_min_minutes, config.daily_max_minutes,
    config.study_start_time, now
  )
  return getExamConfig(db)!
}

export function getDaysUntilExam(db: Database.Database): number | null {
  const config = getExamConfig(db)
  if (!config || !config.exam_date) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const exam = new Date(config.exam_date)
  exam.setHours(23, 59, 59, 0)
  return Math.max(0, Math.ceil((exam.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)))
}
