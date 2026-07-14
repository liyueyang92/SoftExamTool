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

  // Composite dedup: reuse existing group matching (name, group_type, exam_year, exam_period)
  let id: string | null = input.id ?? null
  let isNew = !id
  if (!id) {
    if (skipNameDedup) {
      id = randomUUID()
      isNew = true
    } else {
      const existing = db.prepare(`
        SELECT id FROM question_groups
        WHERE name = ? AND group_type = ?
          AND COALESCE(exam_year, -1) = COALESCE(?, -1)
          AND COALESCE(exam_period, '') = COALESCE(?, '')
      `).get(input.name, groupType, examYear, examPeriod) as { id: string } | undefined
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
    const insResult = db.prepare(`
      INSERT OR IGNORE INTO question_groups
        (id, name, group_type, exam_year, exam_period, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, groupType, examYear, examPeriod, description, now, now)

    if (insResult.changes === 0) {
      // UNIQUE constraint prevented insert — race / lookup mismatch, find existing and update
      const conflictId = db.prepare(`
        SELECT id FROM question_groups
        WHERE name = ? AND group_type = ?
          AND COALESCE(exam_year, -1) = COALESCE(?, -1)
          AND COALESCE(exam_period, '') = COALESCE(?, '')
      `).get(input.name, groupType, examYear, examPeriod) as { id: string } | undefined
      if (conflictId) {
        id = conflictId.id
        db.prepare(`
          UPDATE question_groups
          SET name = ?, group_type = ?, exam_year = ?, exam_period = ?, description = ?, updated_at = ?
          WHERE id = ?
        `).run(input.name, groupType, examYear, examPeriod, description, now, id)
      }
    }
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

export function syncGroupExamMeta(db: Database): { updated: number; merged: number } {
  const groups = listQuestionGroups(db)
  let updated = 0

  // Phase 1: reorganize — for each group, split questions by (exam_year, exam_period),
  // creating new groups as needed for mismatches, then update group's own metadata.
  for (const group of groups) {
    // Find distinct exam metadata combos in this group's questions
    const combos = db.prepare(`
      SELECT exam_year, exam_period, COUNT(*) as cnt
      FROM questions
      WHERE group_id = ? AND exam_year IS NOT NULL
      GROUP BY exam_year, COALESCE(exam_period, '')
      ORDER BY cnt DESC
    `).all(group.id) as Array<{ exam_year: number; exam_period: string | null; cnt: number }>

    if (combos.length === 0) continue

    // The most common combo stays with this group; update the group's metadata
    const primary = combos[0]
    if (primary.exam_year !== group.exam_year || primary.exam_period !== group.exam_period) {
      db.prepare(`
        UPDATE question_groups
        SET exam_year = ?, exam_period = ?, updated_at = ?
        WHERE id = ?
      `).run(primary.exam_year, primary.exam_period ?? null, new Date().toISOString(), group.id)
      updated++
    }

    // For other combos, create/find a matching group and move questions there
    for (let i = 1; i < combos.length; i++) {
      const combo = combos[i]
      // Use upsert to dedup: find or create a group with same name/type but this year/period
      const target = upsertQuestionGroup(db, {
        name: group.name,
        group_type: group.group_type as QuestionGroupType,
        exam_year: combo.exam_year,
        exam_period: combo.exam_period as ExamPeriod,
        description: group.description,
      })
      db.prepare(`
        UPDATE questions SET group_id = ?
        WHERE group_id = ? AND exam_year = ? AND COALESCE(exam_period, '') = COALESCE(?, '')
      `).run(target.id, group.id, combo.exam_year, combo.exam_period)
      updated++
    }
  }

  // Phase 2: deduplicate — merge groups sharing the same (name, group_type, exam_year, exam_period)
  let merged = 0

  const dupKeys = db.prepare(`
    SELECT name, group_type, COALESCE(exam_year, -1) AS ey, COALESCE(exam_period, '') AS ep
    FROM question_groups
    GROUP BY name, group_type, COALESCE(exam_year, -1), COALESCE(exam_period, '')
    HAVING COUNT(*) > 1
  `).all() as Array<{ name: string; group_type: string; ey: number; ep: string }>

  for (const key of dupKeys) {
    const keeper = db.prepare(`
      SELECT id FROM question_groups
      WHERE name = ? AND group_type = ?
        AND COALESCE(exam_year, -1) = ?
        AND COALESCE(exam_period, '') = ?
      ORDER BY
        (SELECT COUNT(*) FROM questions WHERE group_id = question_groups.id) DESC,
        created_at ASC
      LIMIT 1
    `).get(key.name, key.group_type, key.ey, key.ep) as { id: string }

    const dupIds = db.prepare(`
      SELECT id FROM question_groups
      WHERE name = ? AND group_type = ?
        AND COALESCE(exam_year, -1) = ?
        AND COALESCE(exam_period, '') = ?
        AND id != ?
    `).all(key.name, key.group_type, key.ey, key.ep, keeper.id) as Array<{ id: string }>

    for (const dup of dupIds) {
      db.prepare('UPDATE questions SET group_id = ? WHERE group_id = ?').run(keeper.id, dup.id)
      db.prepare('DELETE FROM question_groups WHERE id = ?').run(dup.id)
      merged++
    }
  }

  return { updated, merged }
}
