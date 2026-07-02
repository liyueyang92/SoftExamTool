import type { Database } from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

export type QuestionGroupType = 'custom' | 'past_exam' | 'ai_generated' | 'crawled' | 'manual_import'
export type ExamPeriod = 'H1' | 'H2'

export interface QuestionGroup {
  id: string
  name: string
  group_type: QuestionGroupType
  exam_year: number | null
  exam_period: ExamPeriod | null
  description: string
  created_at: string
  updated_at: string
}

export interface QuestionGroupInput {
  name: string
  group_type?: QuestionGroupType
  exam_year?: number | null
  exam_period?: ExamPeriod | null
  description?: string
}

export function listQuestionGroups(db: Database): QuestionGroup[] {
  return db.prepare(`
    SELECT *
    FROM question_groups
    ORDER BY
      CASE group_type
        WHEN 'past_exam' THEN 0
        WHEN 'ai_generated' THEN 1
        WHEN 'crawled' THEN 2
        WHEN 'manual_import' THEN 3
        ELSE 4
      END,
      exam_year DESC,
      exam_period DESC,
      updated_at DESC
  `).all() as QuestionGroup[]
}

export function getQuestionGroup(db: Database, id: string): QuestionGroup | null {
  return db.prepare('SELECT * FROM question_groups WHERE id = ?').get(id) as QuestionGroup | null
}

export function upsertQuestionGroup(
  db: Database,
  input: QuestionGroupInput & { id?: string }
): QuestionGroup {
  const id = input.id ?? randomUUID()
  const now = new Date().toISOString()
  const groupType = input.group_type ?? 'custom'
  const description = input.description ?? ''
  const examYear = groupType === 'past_exam' ? (input.exam_year ?? null) : null
  const examPeriod = groupType === 'past_exam' ? (input.exam_period ?? null) : null

  if (groupType === 'past_exam' && (!examYear || !examPeriod)) {
    throw Object.assign(new Error('历年真题分组必须填写年份和上/下半年'), { code: 'QUESTION_GROUP_INVALID' })
  }

  if (input.id) {
    db.prepare(`
      UPDATE question_groups
      SET name = ?, group_type = ?, exam_year = ?, exam_period = ?, description = ?, updated_at = ?
      WHERE id = ?
    `).run(input.name, groupType, examYear, examPeriod, description, now, id)
  } else {
    db.prepare(`
      INSERT INTO question_groups
        (id, name, group_type, exam_year, exam_period, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, groupType, examYear, examPeriod, description, now, now)
  }

  return db.prepare('SELECT * FROM question_groups WHERE id = ?').get(id) as QuestionGroup
}

export function deleteQuestionGroup(db: Database, id: string): void {
  db.prepare('DELETE FROM question_groups WHERE id = ?').run(id)
}
