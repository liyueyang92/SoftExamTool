import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'
import type { ExamPeriod, QuestionGroupType } from './question-groups'

export interface Question {
  id: string
  group_id: string | null
  question_set_id: string | null
  question_set_order: number
  type: 'single' | 'multiple' | 'case' | 'essay'
  content: string
  options: string[] | null
  answer: string | null
  explanation: string | null
  knowledge_tags: string[]
  difficulty: number
  source_type: 'manual' | 'ai_generated' | 'crawled' | 'imported'
  source_url: string | null
  content_hash: string | null
  is_favorite: number
  group_name?: string | null
  group_type?: QuestionGroupType | null
  exam_year?: number | null
  exam_period?: ExamPeriod | null
  created_at: string
}

export interface QuestionInput {
  group_id?: string | null
  question_set_id?: string | null
  question_set_order?: number | null
  type: Question['type']
  content: string
  options?: string[] | null
  answer?: string | null
  explanation?: string | null
  knowledge_tags?: string[]
  difficulty?: number
  source_type?: Question['source_type']
  source_url?: string | null
  content_hash?: string | null
  exam_year?: number | null
  exam_period?: ExamPeriod | null
}

export interface QueryFilter {
  group_id?: string
  group_name?: string
  group_type?: QuestionGroupType
  exam_year?: number
  exam_period?: ExamPeriod
  type?: string
  difficulty?: number
  source_type?: string
  knowledge_tag?: string
  is_favorite?: boolean
  has_images?: boolean
  has_img_tags?: boolean
  page?: number
  pageSize?: number
}

function parseQuestion(row: Record<string, unknown>): Question {
  return {
    ...row,
    options: row.options ? normalizeOptions(JSON.parse(row.options as string) as string[]) : null,
    knowledge_tags: JSON.parse((row.knowledge_tags as string) || '[]'),
  } as Question
}

function normalizeContentKey(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

function normalizeQuestionInput(input: QuestionInput): QuestionInput {
  return {
    ...input,
    options: normalizeOptions(input.options),
  }
}

function normalizeOptions(options?: string[] | null): string[] | null {
  const values = (options ?? []).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const normalized: string[] = []
  for (const value of values) {
    const split = splitCombinedOptions(value)
    if (split.length > 1) normalized.push(...split)
    else normalized.push(value)
  }
  const seen = new Set<string>()
  const result = normalized.filter((item) => {
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
  return result.length ? result : null
}

function normalizeOptionsKey(options?: string[] | null): string {
  return (normalizeOptions(options) ?? []).join('|')
}

function splitCombinedOptions(text: string): string[] {
  const patterns = [
    /(?<![A-Za-z0-9])([A-H])\s*[.．、:：)）]/g,
    /(?<![A-Za-z0-9])([A-H])(?=\s+\S)/g,
    /(?<![A-Za-z0-9])([A-H])(?=[\u4e00-\u9fff])/g,
  ]
  for (const pattern of patterns) {
    const matches = Array.from(text.matchAll(pattern))
    if (!looksLikeOptionSequence(matches)) continue
    return matches.map((match, index) => {
      const start = match.index ?? 0
      const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length
      return text.slice(start, end).trim()
    }).filter(Boolean)
  }
  return []
}

function looksLikeOptionSequence(matches: RegExpMatchArray[]): boolean {
  if (matches.length < 2) return false
  const indexes = matches.map((match) => String(match[1]).charCodeAt(0) - 'A'.charCodeAt(0))
  return indexes[0] === 0 && indexes.every((value, index) => index === 0 || value > indexes[index - 1])
}

function attachQuestionSets(db: Database.Database, inputs: QuestionInput[]): QuestionInput[] {
  const prepared = inputs.map(normalizeQuestionInput)
  const groups = new Map<string, Array<{ input: QuestionInput; index: number; optionsKey: string }>>()

  prepared.forEach((input, index) => {
    if (input.question_set_id) return
    const contentKey = normalizeContentKey(input.content)
    if (!contentKey) return
    const optionsKey = normalizeOptionsKey(input.options)
    if (!optionsKey) return
    const list = groups.get(contentKey) ?? []
    list.push({ input, index, optionsKey })
    groups.set(contentKey, list)
  })

  for (const [contentKey, items] of groups.entries()) {
    const existing = db.prepare(`
      SELECT id, options, question_set_id, question_set_order, created_at
      FROM questions
      WHERE content = ? AND options IS NOT NULL AND trim(options) <> ''
      ORDER BY question_set_order ASC, created_at ASC, id ASC
    `).all(contentKey) as Array<{
      id: string
      options: string
      question_set_id: string | null
      question_set_order: number
      created_at: string
    }>
    const existingOptions = existing.map((item) => normalizeOptionsKey(JSON.parse(item.options) as string[]))
    const distinctOptions = new Set([...items.map((item) => item.optionsKey), ...existingOptions])
    if ((items.length + existing.length) <= 1 || distinctOptions.size <= 1) continue

    const existingSetId = existing.find((item) => item.question_set_id)?.question_set_id
    const setId = existingSetId || randomUUID()
    if (!existingSetId && existing.length) {
      const updateExisting = db.prepare('UPDATE questions SET question_set_id = ?, question_set_order = ? WHERE id = ?')
      existing.forEach((item, order) => updateExisting.run(setId, order + 1, item.id))
    } else if (existingSetId) {
      const updateExisting = db.prepare('UPDATE questions SET question_set_id = ? WHERE id = ? AND question_set_id IS NULL')
      existing.forEach((item) => updateExisting.run(existingSetId, item.id))
    }
    const startOrder = existing.length
    items
      .sort((a, b) => a.index - b.index)
      .forEach((item, order) => {
        item.input.question_set_id = setId
        item.input.question_set_order = startOrder + order + 1
      })
  }

  return prepared
}

export function queryQuestions(db: Database.Database, filter: QueryFilter = {}): { items: Question[]; total: number } {
  const { page = 1, pageSize = 20 } = filter
  const { conditions, params } = buildFilterConditions(filter)

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
      g.group_type AS group_type
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    ${where}
    ORDER BY
      COALESCE(
        (SELECT MIN(qs.created_at) FROM questions qs WHERE qs.question_set_id = q.question_set_id),
        q.created_at
      ) DESC,
      COALESCE(q.question_set_id, q.id) DESC,
      CASE WHEN q.question_set_id IS NULL THEN 0 ELSE q.question_set_order END ASC,
      q.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as Record<string, unknown>[]

  return { items: expandQuestionSets(db, rows.map(parseQuestion)), total }
}

export function searchQuestions(db: Database.Database, q: string, limit = 30): Question[] {
  const rows = db.prepare(`
    SELECT
      q.*,
      g.name AS group_name,
      g.group_type AS group_type
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    JOIN questions_fts fts ON q.rowid = fts.rowid
    WHERE questions_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(q + '*', limit) as Record<string, unknown>[]
  return expandQuestionSets(db, rows.map(parseQuestion))
}

export function getQuestionSetMembers(db: Database.Database, questionSetId: string): Question[] {
  const rows = db.prepare(`
    SELECT
      q.*,
      g.name AS group_name,
      g.group_type AS group_type
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    WHERE q.question_set_id = ?
    ORDER BY q.question_set_order ASC, q.created_at ASC
  `).all(questionSetId) as Record<string, unknown>[]
  return rows.map(parseQuestion)
}

export function expandQuestionSets(db: Database.Database, questions: Question[]): Question[] {
  const result: Question[] = []
  const seen = new Set<string>()
  const expandedSets = new Set<string>()
  for (const question of questions) {
    const setId = question.question_set_id
    if (!setId) {
      if (!seen.has(question.id)) {
        result.push(question)
        seen.add(question.id)
      }
      continue
    }
    if (expandedSets.has(setId)) continue
    expandedSets.add(setId)
    for (const member of getQuestionSetMembers(db, setId)) {
      if (seen.has(member.id)) continue
      result.push(member)
      seen.add(member.id)
    }
  }
  return result
}

export function insertQuestion(db: Database.Database, input: QuestionInput): Question {
  const id = randomUUID()
  const now = new Date().toISOString()
  const prepared = attachQuestionSets(db, [input])[0]
  db.prepare(`
    INSERT INTO questions
      (id, group_id, question_set_id, question_set_order, type, content, options, answer, explanation, knowledge_tags, difficulty, source_type, source_url, content_hash, exam_year, exam_period, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    prepared.group_id ?? null,
    prepared.question_set_id ?? null,
    prepared.question_set_order ?? 0,
    prepared.type,
    prepared.content,
    prepared.options ? JSON.stringify(prepared.options) : null,
    prepared.answer ?? null,
    prepared.explanation ?? null,
    JSON.stringify(prepared.knowledge_tags ?? []),
    prepared.difficulty ?? 3,
    prepared.source_type ?? 'manual',
    prepared.source_url ?? null,
    prepared.content_hash ?? null,
    prepared.exam_year ?? null,
    prepared.exam_period ?? null,
    now
  )
  return db.prepare(`
    SELECT
      q.*,
      g.name AS group_name,
      g.group_type AS group_type
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    WHERE q.id = ?
  `).get(id) as Question
}

export function batchInsertQuestions(db: Database.Database, inputs: QuestionInput[]): number {
  const stmt = db.prepare(`
    INSERT INTO questions
      (id, group_id, question_set_id, question_set_order, type, content, options, answer, explanation, knowledge_tags, difficulty, source_type, source_url, content_hash, exam_year, exam_period, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insert = db.transaction((items: QuestionInput[]) => {
    for (const input of attachQuestionSets(db, items)) {
      stmt.run(
        randomUUID(),
        input.group_id ?? null,
        input.question_set_id ?? null,
        input.question_set_order ?? 0,
        input.type,
        input.content,
        input.options ? JSON.stringify(input.options) : null,
        input.answer ?? null,
        input.explanation ?? null,
        JSON.stringify(input.knowledge_tags ?? []),
        input.difficulty ?? 3,
        input.source_type ?? 'manual',
        input.source_url ?? null,
        input.content_hash ?? null,
        input.exam_year ?? null,
        input.exam_period ?? null,
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
  if (changes.question_set_id !== undefined) { fields.push('question_set_id = ?'); vals.push(changes.question_set_id) }
  if (changes.question_set_order !== undefined) { fields.push('question_set_order = ?'); vals.push(changes.question_set_order ?? 0) }
  if (changes.type !== undefined) { fields.push('type = ?'); vals.push(changes.type) }
  if (changes.content !== undefined) { fields.push('content = ?'); vals.push(changes.content) }
  if (changes.options !== undefined) { fields.push('options = ?'); vals.push(changes.options ? JSON.stringify(changes.options) : null) }
  if (changes.answer !== undefined) { fields.push('answer = ?'); vals.push(changes.answer) }
  if (changes.explanation !== undefined) { fields.push('explanation = ?'); vals.push(changes.explanation) }
  if (changes.knowledge_tags !== undefined) { fields.push('knowledge_tags = ?'); vals.push(JSON.stringify(changes.knowledge_tags)) }
  if (changes.difficulty !== undefined) { fields.push('difficulty = ?'); vals.push(changes.difficulty) }
  if (changes.source_type !== undefined) { fields.push('source_type = ?'); vals.push(changes.source_type) }
  if (changes.source_url !== undefined) { fields.push('source_url = ?'); vals.push(changes.source_url) }
  if (changes.exam_year !== undefined) { fields.push('exam_year = ?'); vals.push(changes.exam_year ?? null) }
  if (changes.exam_period !== undefined) { fields.push('exam_period = ?'); vals.push(changes.exam_period ?? null) }
  if (!fields.length) return
  vals.push(id)
  db.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE id = ?`).run(...vals)
}

export function deleteQuestion(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM questions WHERE id = ?').run(id)
}

export function batchDeleteQuestions(db: Database.Database, ids: string[]): number {
  if (!ids.length) return 0
  const placeholders = ids.map(() => '?').join(',')
  const result = db.prepare(`DELETE FROM questions WHERE id IN (${placeholders})`).run(...ids)
  return result.changes
}

export function toggleFavorite(db: Database.Database, id: string): number {
  db.prepare('UPDATE questions SET is_favorite = 1 - is_favorite WHERE id = ?').run(id)
  return (db.prepare('SELECT is_favorite FROM questions WHERE id = ?').get(id) as { is_favorite: number }).is_favorite
}

function buildFilterConditions(filter: QueryFilter): { conditions: string[]; params: unknown[] } {
  const {
    group_id,
    group_name,
    group_type,
    exam_year,
    exam_period,
    type,
    difficulty,
    source_type,
    knowledge_tag,
    is_favorite,
    has_images,
    has_img_tags,
  } = filter
  const conditions: string[] = []
  const params: unknown[] = []

  if (group_id) { conditions.push('q.group_id = ?'); params.push(group_id) }
  if (group_name) { conditions.push('g.name = ?'); params.push(group_name) }
  if (group_type) { conditions.push('g.group_type = ?'); params.push(group_type) }
  if (exam_year) { conditions.push('q.exam_year = ?'); params.push(exam_year) }
  if (exam_period) { conditions.push('q.exam_period = ?'); params.push(exam_period) }
  if (type) { conditions.push('q.type = ?'); params.push(type) }
  if (difficulty) { conditions.push('q.difficulty = ?'); params.push(difficulty) }
  if (source_type) { conditions.push('q.source_type = ?'); params.push(source_type) }
  if (knowledge_tag) { conditions.push('q.knowledge_tags LIKE ?'); params.push(`%${knowledge_tag}%`) }
  if (is_favorite) { conditions.push('q.is_favorite = 1') }
  if (has_images !== undefined) {
    if (has_images) {
      conditions.push("EXISTS (SELECT 1 FROM question_images WHERE question_images.question_id = q.id)")
    } else {
      conditions.push("NOT EXISTS (SELECT 1 FROM question_images WHERE question_images.question_id = q.id)")
    }
  }
  if (has_img_tags !== undefined) {
    if (has_img_tags) {
      conditions.push("(q.content LIKE '%<img%' OR q.options LIKE '%<img%' OR q.explanation LIKE '%<img%')")
    } else {
      conditions.push("(q.content NOT LIKE '%<img%' AND (q.options NOT LIKE '%<img%' OR q.options IS NULL) AND (q.explanation NOT LIKE '%<img%' OR q.explanation IS NULL))")
    }
  }

  return { conditions, params }
}

export function exportQuestions(db: Database.Database, filter: QueryFilter = {}): Question[] {
  const { conditions, params } = buildFilterConditions(filter)
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = db.prepare(`
    SELECT
      q.*,
      g.name AS group_name,
      g.group_type AS group_type
    FROM questions q
    LEFT JOIN question_groups g ON q.group_id = g.id
    ${where}
    ORDER BY q.created_at DESC
  `).all(...params) as Record<string, unknown>[]

  return expandQuestionSets(db, rows.map(parseQuestion))
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
      g.group_type AS group_type
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
