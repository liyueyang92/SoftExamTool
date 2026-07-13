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
  input: QuestionGroupInput & { id?: string; skipNameDedup?: boolean }
): QuestionGroup {
  const now = new Date().toISOString()
  const groupType = input.group_type ?? 'custom'
  const description = input.description ?? ''
  const examYear = input.exam_year ?? null
  const examPeriod = input.exam_period ?? null
  const skipNameDedup = input.skipNameDedup === true

  // Name-based dedup: when no explicit id, reuse existing group with same name
  let id: string | null = input.id ?? null
  let isNew = !id
  if (!id) {
    if (skipNameDedup) {
      id = randomUUID()
      isNew = true
    } else {
      const existing = db.prepare(
        'SELECT id FROM question_groups WHERE name = ?'
      ).get(input.name) as { id: string } | undefined
      if (existing) {
        id = existing.id
        isNew = false
      } else {
        id = randomUUID()
        isNew = true
      }
    }
  }

  if (isNew) {
    db.prepare(`
      INSERT INTO question_groups
        (id, name, group_type, exam_year, exam_period, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, groupType, examYear, examPeriod, description, now, now)
  } else {
    db.prepare(`
      UPDATE question_groups
      SET name = ?, group_type = ?, exam_year = ?, exam_period = ?, description = ?, updated_at = ?
      WHERE id = ?
    `).run(input.name, groupType, examYear, examPeriod, description, now, id)
  }

  return db.prepare('SELECT * FROM question_groups WHERE id = ?').get(id) as QuestionGroup
}

export function countQuestionsInGroup(db: Database, id: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as n FROM questions WHERE group_id = ?'
  ).get(id) as { n: number }
  return row.n
}

export function moveQuestionsToGroup(
  db: Database,
  fromGroupId: string,
  toGroupId: string
): number {
  const target = getQuestionGroup(db, toGroupId)
  if (!target) {
    throw Object.assign(new Error('目标分组不存在'), { code: 'QUESTION_GROUP_NOT_FOUND' })
  }
  if (fromGroupId === toGroupId) {
    throw Object.assign(new Error('源分组和目标分组不能相同'), { code: 'QUESTION_GROUP_SAME' })
  }
  const result = db.prepare(
    'UPDATE questions SET group_id = ? WHERE group_id = ?'
  ).run(toGroupId, fromGroupId)
  return result.changes
}

export function deleteQuestionGroup(db: Database, id: string): void {
  const count = countQuestionsInGroup(db, id)
  if (count > 0) {
    throw Object.assign(
      new Error(`分组内还有 ${count} 道题目，请先移动或删除题目`),
      { code: 'QUESTION_GROUP_NOT_EMPTY' }
    )
  }
  db.prepare('DELETE FROM question_groups WHERE id = ?').run(id)
}
