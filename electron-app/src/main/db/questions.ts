import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

export interface Question {
  id: string
  type: 'single' | 'multiple' | 'case' | 'essay'
  content: string
  options: string[] | null
  answer: string | null
  explanation: string | null
  knowledge_tags: string[]
  difficulty: number
  source_type: 'manual' | 'ai_generated' | 'crawled' | 'imported'
  is_favorite: number
  created_at: string
}

export interface QuestionInput {
  type: Question['type']
  content: string
  options?: string[] | null
  answer?: string | null
  explanation?: string | null
  knowledge_tags?: string[]
  difficulty?: number
  source_type?: Question['source_type']
}

export interface QueryFilter {
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
  const { page = 1, pageSize = 20, type, difficulty, source_type, knowledge_tag, is_favorite } = filter
  const conditions: string[] = []
  const params: unknown[] = []

  if (type) { conditions.push("type = ?"); params.push(type) }
  if (difficulty) { conditions.push("difficulty = ?"); params.push(difficulty) }
  if (source_type) { conditions.push("source_type = ?"); params.push(source_type) }
  if (knowledge_tag) { conditions.push("knowledge_tags LIKE ?"); params.push(`%${knowledge_tag}%`) }
  if (is_favorite) { conditions.push("is_favorite = 1") }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const offset = (page - 1) * pageSize

  const total = (db.prepare(`SELECT COUNT(*) as n FROM questions ${where}`).get(...params) as { n: number }).n
  const rows = db.prepare(`SELECT * FROM questions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as Record<string, unknown>[]

  return { items: rows.map(parseQuestion), total }
}

export function searchQuestions(db: Database.Database, q: string, limit = 30): Question[] {
  const rows = db.prepare(`
    SELECT q.* FROM questions q
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
    INSERT INTO questions (id, type, content, options, answer, explanation, knowledge_tags, difficulty, source_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type,
    input.content,
    input.options ? JSON.stringify(input.options) : null,
    input.answer ?? null,
    input.explanation ?? null,
    JSON.stringify(input.knowledge_tags ?? []),
    input.difficulty ?? 3,
    input.source_type ?? 'manual',
    now
  )
  return db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Question
}

export function batchInsertQuestions(db: Database.Database, inputs: QuestionInput[]): number {
  const stmt = db.prepare(`
    INSERT INTO questions (id, type, content, options, answer, explanation, knowledge_tags, difficulty, source_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insert = db.transaction((items: QuestionInput[]) => {
    for (const input of items) {
      stmt.run(
        randomUUID(),
        input.type,
        input.content,
        input.options ? JSON.stringify(input.options) : null,
        input.answer ?? null,
        input.explanation ?? null,
        JSON.stringify(input.knowledge_tags ?? []),
        input.difficulty ?? 3,
        input.source_type ?? 'manual',
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
  if (changes.type !== undefined) { fields.push('type = ?'); vals.push(changes.type) }
  if (changes.content !== undefined) { fields.push('content = ?'); vals.push(changes.content) }
  if (changes.options !== undefined) { fields.push('options = ?'); vals.push(changes.options ? JSON.stringify(changes.options) : null) }
  if (changes.answer !== undefined) { fields.push('answer = ?'); vals.push(changes.answer) }
  if (changes.explanation !== undefined) { fields.push('explanation = ?'); vals.push(changes.explanation) }
  if (changes.knowledge_tags !== undefined) { fields.push('knowledge_tags = ?'); vals.push(JSON.stringify(changes.knowledge_tags)) }
  if (changes.difficulty !== undefined) { fields.push('difficulty = ?'); vals.push(changes.difficulty) }
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
  const favorites = (db.prepare('SELECT COUNT(*) as n FROM questions WHERE is_favorite = 1').get() as { n: number }).n
  const todayAnswered = (db.prepare(`
    SELECT COUNT(*) as n FROM answer_records
    WHERE answered_at >= date('now','start of day')
  `).get() as { n: number }).n
  const todayCorrect = (db.prepare(`
    SELECT COUNT(*) as n FROM answer_records
    WHERE answered_at >= date('now','start of day') AND is_correct = 1
  `).get() as { n: number }).n

  return { total, byType, bySource, favorites, todayAnswered, todayCorrect }
}

export function getWrongQuestions(db: Database.Database, limit = 50): Question[] {
  const rows = db.prepare(`
    SELECT q.* FROM questions q
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
