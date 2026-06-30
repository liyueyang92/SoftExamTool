import type { Database } from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

export interface Essay {
  id: string
  title: string
  question: string
  version: number
  word_count: number
  created_at: string
  updated_at: string
}

export interface EssaySection {
  id: string
  essay_id: string
  section_key: string
  content: string
  word_count: number
  updated_at: string
}

export interface EssayVersion {
  id: string
  essay_id: string
  version: number
  snapshot: string
  saved_at: string
}

export interface EssayMaterial {
  id: string
  project_name: string
  background: string
  challenges: string
  solution: string
  outcomes: string
  knowledge_tags: string[]
  created_at: string
  updated_at: string
}

export const SECTION_KEYS = ['abstract', 'background', 'solution', 'practice', 'summary'] as const
export const SECTION_TARGETS: Record<string, number> = {
  abstract: 300, background: 500, solution: 1500, practice: 1000, summary: 300,
}

function parseMat(row: Record<string, unknown>): EssayMaterial {
  return { ...(row as unknown as EssayMaterial), knowledge_tags: JSON.parse(row.knowledge_tags as string ?? '[]') }
}

export function listEssays(db: Database): Essay[] {
  return db.prepare('SELECT * FROM essays ORDER BY updated_at DESC').all() as Essay[]
}

export function createEssay(db: Database, title?: string): Essay {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO essays (id, title, created_at, updated_at) VALUES (?,?,?,?)')
    .run(id, title ?? '未命名论文', now, now)
  for (const key of SECTION_KEYS) {
    db.prepare('INSERT INTO essay_sections (id, essay_id, section_key, updated_at) VALUES (?,?,?,?)')
      .run(randomUUID(), id, key, now)
  }
  return db.prepare('SELECT * FROM essays WHERE id=?').get(id) as Essay
}

export function getEssay(db: Database, id: string): { essay: Essay; sections: EssaySection[] } | null {
  const essay = db.prepare('SELECT * FROM essays WHERE id=?').get(id) as Essay | undefined
  if (!essay) return null
  const sections = db.prepare('SELECT * FROM essay_sections WHERE essay_id=? ORDER BY rowid').all(id) as EssaySection[]
  return { essay, sections }
}

export function updateEssaySection(db: Database, essayId: string, sectionKey: string, content: string): EssaySection {
  const wordCount = content.replace(/\s/g, '').length
  const now = new Date().toISOString()
  db.prepare('UPDATE essay_sections SET content=?, word_count=?, updated_at=? WHERE essay_id=? AND section_key=?')
    .run(content, wordCount, now, essayId, sectionKey)
  const total = (db.prepare('SELECT SUM(word_count) as t FROM essay_sections WHERE essay_id=?').get(essayId) as { t: number }).t ?? 0
  db.prepare('UPDATE essays SET word_count=?, updated_at=? WHERE id=?').run(total, now, essayId)
  return db.prepare('SELECT * FROM essay_sections WHERE essay_id=? AND section_key=?').get(essayId, sectionKey) as EssaySection
}

export function updateEssayMeta(db: Database, id: string, patch: { title?: string; question?: string }): void {
  const sets: string[] = ['updated_at=?']
  const vals: unknown[] = [new Date().toISOString()]
  if (patch.title !== undefined) { sets.push('title=?'); vals.push(patch.title) }
  if (patch.question !== undefined) { sets.push('question=?'); vals.push(patch.question) }
  db.prepare(`UPDATE essays SET ${sets.join(',')} WHERE id=?`).run(...vals, id)
}

export function saveEssayVersion(db: Database, essayId: string): Omit<EssayVersion, 'snapshot'> {
  const data = getEssay(db, essayId)!
  const versionNum = data.essay.version + 1
  const id = randomUUID()
  db.prepare('INSERT INTO essay_versions (id, essay_id, version, snapshot) VALUES (?,?,?,?)')
    .run(id, essayId, versionNum, JSON.stringify(data.sections))
  db.prepare('UPDATE essays SET version=? WHERE id=?').run(versionNum, essayId)
  return { id, essay_id: essayId, version: versionNum, saved_at: new Date().toISOString() }
}

export function listEssayVersions(db: Database, essayId: string): Omit<EssayVersion, 'snapshot'>[] {
  return db.prepare(
    'SELECT id, essay_id, version, saved_at FROM essay_versions WHERE essay_id=? ORDER BY version DESC'
  ).all(essayId) as Omit<EssayVersion, 'snapshot'>[]
}

export function restoreEssayVersion(db: Database, essayId: string, versionId: string): void {
  const ver = db.prepare('SELECT * FROM essay_versions WHERE id=? AND essay_id=?').get(versionId, essayId) as EssayVersion | undefined
  if (!ver) throw new Error('Version not found')
  const sections = JSON.parse(ver.snapshot) as EssaySection[]
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    for (const s of sections) {
      db.prepare('UPDATE essay_sections SET content=?, word_count=?, updated_at=? WHERE essay_id=? AND section_key=?')
        .run(s.content, s.word_count, now, essayId, s.section_key)
    }
    const total = sections.reduce((sum, s) => sum + s.word_count, 0)
    db.prepare('UPDATE essays SET word_count=?, updated_at=? WHERE id=?').run(total, now, essayId)
  })
  tx()
}

export function deleteEssay(db: Database, id: string): void {
  db.prepare('DELETE FROM essays WHERE id=?').run(id)
}

export function listEssayMaterials(db: Database): EssayMaterial[] {
  return (db.prepare('SELECT * FROM essay_materials ORDER BY updated_at DESC').all() as Record<string, unknown>[]).map(parseMat)
}

export function upsertEssayMaterial(
  db: Database,
  mat: Omit<EssayMaterial, 'created_at' | 'updated_at'> & { id?: string }
): EssayMaterial {
  const id = mat.id ?? randomUUID()
  const now = new Date().toISOString()
  const tags = JSON.stringify(mat.knowledge_tags ?? [])
  if (mat.id) {
    db.prepare(`
      UPDATE essay_materials
      SET project_name=?, background=?, challenges=?, solution=?, outcomes=?, knowledge_tags=?, updated_at=?
      WHERE id=?
    `).run(mat.project_name, mat.background, mat.challenges, mat.solution, mat.outcomes, tags, now, id)
  } else {
    db.prepare(`
      INSERT INTO essay_materials
        (id, project_name, background, challenges, solution, outcomes, knowledge_tags, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, mat.project_name, mat.background, mat.challenges, mat.solution, mat.outcomes, tags, now, now)
  }
  return parseMat(db.prepare('SELECT * FROM essay_materials WHERE id=?').get(id) as Record<string, unknown>)
}

export function deleteEssayMaterial(db: Database, id: string): void {
  db.prepare('DELETE FROM essay_materials WHERE id=?').run(id)
}
