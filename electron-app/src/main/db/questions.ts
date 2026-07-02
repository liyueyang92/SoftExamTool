import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'
import type { ExamPeriod, QuestionGroupType } from './question-groups'

export interface Question {
  id: string
  group_id: string | null
  type: 'single' | 'multiple' | 'case' | 'essay'
  content: string
  options: string[] | null
  answer: string | null
  explanation: string | null
  knowledge_tags: string[]
  difficulty: number
  source_type: 'manual' | 'ai_generated' | 'crawled' | 'imported'
  source_url: string | null
  is_favorite: number
  group_name?: string | null
  group_type?: QuestionGroupType | null
  exam_year?: number | null
  exam_period?: ExamPeriod | null
  created_at: string
}

export interface QuestionInput {
  group_id?: string | null
  type: Question['type']
  content: string
  options?: string[] | null
  answer?: string | null
  explanation?: string | null
  knowledge_tags?: string[]
  difficulty?: number
  source_type?: Question['source_type']
  source_url?: string | null
}

export interface QueryFilter {
  group_id?: string
  group_type?: QuestionGroupType
  exam_year?: number
  exam_period?: ExamPeriod
  type?: string
  difficulty?: number
  source_type?: string
  knowledge_tag?: string
  is_favorite?: boolean
  page?: number
  pageSize?: number
}

function parseQuestion(row: Record<string, unknown>): Question {
  return {
    ...row,
    options: row.options ? JSON.parse(row.options as string) : null,
    knowledge_tags: JSON.parse((row.knowledge_tags as string) || '[]'),
  } as Question
}

export function queryQuestions(db: Database.Database, filter: QueryFilter = {}): { items: Question[]; total: number } {
  const {
    page = 1,
    pageSize = 20,
    group_id,
    group_type,
    exam_year,
    exam_period,
    type,
    difficulty,
    source_type,
    knowledge_tag,
    is_favorite,
  } = filter
  const conditions: string[] = []
  const params: unknown[] = []

  if (group_id) { conditions.push('q.group_id = ?'); params.push(group_id) }
  if (group_type) { conditions.push('g.group_type = ?'); params.push(group_type) }
  if (exam_year) { conditions.push('g.exam_year = ?'); params.push(exam_year) }
  if (exam_period) { conditions.push('g.exam_period = ?'); params.push(exam_period) }
  if (type) { conditions.push('q.type = ?'); params.push(type) }
  if (difficulty) { conditions.push('q.difficulty = ?'); params.push(difficulty) }
  if (source_type) { conditions.push('q.source_type = ?'); params.push(source_type) }
  if (knowledge_tag) { conditions.push('q.knowledge_tags LIKE ?'); params.push(`%${knowledge_tag}%`) }
  if (is_favorite) { conditions.push('q.is_favorite = 1') }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const offset = (page - 1) * pageSize

  const total = (db.prepare(`
    SELECT COUNT(*) as n
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    ${where}
  `).get(...params) as { n: number }).n
  const rows = db.prepare(`
    SELECT
      q.*,
      g.name AS group_name,
      g.group_type AS group_type,
      g.exam_year AS exam_year,
      g.exam_period AS exam_period
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    ${where}
    ORDER BY q.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as Record<string, unknown>[]

  return { items: rows.map(parseQuestion), total }
}

export function searchQuestions(db: Database.Database, q: string, limit = 30): Question[] {
  const rows = db.prepare(`
    SELECT
      q.*,
      g.name AS group_name,
      g.group_type AS group_type,
      g.exam_year AS exam_year,
      g.exam_period AS exam_period
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    JOIN questions_fts fts ON q.rowid = fts.rowid
    WHERE questions_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(q + '*', limit) as Record<string, unknown>[]
  return rows.map(parseQuestion)
}

export function insertQuestion(db: Database.Database, input: QuestionInput): Question {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO questions
      (id, group_id, type, content, options, answer, explanation, knowledge_tags, difficulty, source_type, source_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.group_id ?? null,
    input.type,
    input.content,
    input.options ? JSON.stringify(input.options) : null,
    input.answer ?? null,
    input.explanation ?? null,
    JSON.stringify(input.knowledge_tags ?? []),
    input.difficulty ?? 3,
    input.source_type ?? 'manual',
    input.source_url ?? null,
    now
  )
  return db.prepare(`
    SELECT
      q.*,
      g.name AS group_name,
      g.group_type AS group_type,
      g.exam_year AS exam_year,
      g.exam_period AS exam_period
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    WHERE q.id = ?
  `).get(id) as Question
}

export function batchInsertQuestions(db: Database.Database, inputs: QuestionInput[]): number {
  const stmt = db.prepare(`
    INSERT INTO questions
      (id, group_id, type, content, options, answer, explanation, knowledge_tags, difficulty, source_type, source_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insert = db.transaction((items: QuestionInput[]) => {
    for (const input of items) {
      stmt.run(
        randomUUID(),
        input.group_id ?? null,
        input.type,
        input.content,
        input.options ? JSON.stringify(input.options) : null,
        input.answer ?? null,
        input.explanation ?? null,
        JSON.stringify(input.knowledge_tags ?? []),
        input.difficulty ?? 3,
        input.source_type ?? 'manual',
        input.source_url ?? null,
        new Date().toISOString()
      )
    }
  })
  insert(inputs)
  return inputs.length
}

export function updateQuestion(db: Database.Database, id: string, changes: Partial<QuestionInput>): void {
  const fields: string[] = []
  const vals: unknown[] = []
  if (changes.group_id !== undefined) { fields.push('group_id = ?'); vals.push(changes.group_id) }
  if (changes.type !== undefined) { fields.push('type = ?'); vals.push(changes.type) }
  if (changes.content !== undefined) { fields.push('content = ?'); vals.push(changes.content) }
  if (changes.options !== undefined) { fields.push('options = ?'); vals.push(changes.options ? JSON.stringify(changes.options) : null) }
  if (changes.answer !== undefined) { fields.push('answer = ?'); vals.push(changes.answer) }
  if (changes.explanation !== undefined) { fields.push('explanation = ?'); vals.push(changes.explanation) }
  if (changes.knowledge_tags !== undefined) { fields.push('knowledge_tags = ?'); vals.push(JSON.stringify(changes.knowledge_tags)) }
  if (changes.difficulty !== undefined) { fields.push('difficulty = ?'); vals.push(changes.difficulty) }
  if (changes.source_type !== undefined) { fields.push('source_type = ?'); vals.push(changes.source_type) }
  if (changes.source_url !== undefined) { fields.push('source_url = ?'); vals.push(changes.source_url) }
  if (!fields.length) return
  vals.push(id)
  db.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE id = ?`).run(...vals)
}

export function deleteQuestion(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM questions WHERE id = ?').run(id)
}

export function toggleFavorite(db: Database.Database, id: string): number {
  db.prepare('UPDATE questions SET is_favorite = 1 - is_favorite WHERE id = ?').run(id)
  return (db.prepare('SELECT is_favorite FROM questions WHERE id = ?').get(id) as { is_favorite: number }).is_favorite
}

export function getQuestionStats(db: Database.Database): Record<string, unknown> {
  const total = (db.prepare('SELECT COUNT(*) as n FROM questions').get() as { n: number }).n
  const byType = db.prepare('SELECT type, COUNT(*) as n FROM questions GROUP BY type').all()
  const bySource = db.prepare('SELECT source_type, COUNT(*) as n FROM questions GROUP BY source_type').all()
  const byGroupType = db.prepare(`
    SELECT COALESCE(g.group_type, 'ungrouped') as group_type, COUNT(*) as n
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    GROUP BY COALESCE(g.group_type, 'ungrouped')
  `).all()
  const favorites = (db.prepare('SELECT COUNT(*) as n FROM questions WHERE is_favorite = 1').get() as { n: number }).n
  const todayAnswered = (db.prepare(`
    SELECT COUNT(*) as n FROM answer_records
    WHERE answered_at >= date('now','start of day')
  `).get() as { n: number }).n
  const todayCorrect = (db.prepare(`
    SELECT COUNT(*) as n FROM answer_records
    WHERE answered_at >= date('now','start of day') AND is_correct = 1
  `).get() as { n: number }).n

  return { total, byType, bySource, byGroupType, favorites, todayAnswered, todayCorrect }
}

export function getWrongQuestions(db: Database.Database, limit = 50): Question[] {
  const rows = db.prepare(`
    SELECT
      q.*,
      g.name AS group_name,
      g.group_type AS group_type,
      g.exam_year AS exam_year,
      g.exam_period AS exam_period
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    WHERE q.id IN (
      SELECT question_id FROM answer_records
      WHERE is_correct = 0
      GROUP BY question_id
      ORDER BY MAX(answered_at) DESC
      LIMIT ?
    )
  `).all(limit) as Record<string, unknown>[]
  return rows.map(parseQuestion)
}
