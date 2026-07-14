import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { extname, join } from 'path'

export interface QuestionImage {
  id: string
  question_id: string
  field_name: 'content' | 'options' | 'explanation'
  file_name: string
  original_name: string
  mime_type: string
  file_size: number
  width: number | null
  height: number | null
  created_at: string
}

export interface InsertImageArgs {
  question_id: string
  field_name: QuestionImage['field_name']
  file_name: string
  original_name: string
  mime_type: string
  file_size: number
  width?: number | null
  height?: number | null
}

function parseImage(row: Record<string, unknown>): QuestionImage {
  return {
    id: row.id as string,
    question_id: row.question_id as string,
    field_name: row.field_name as QuestionImage['field_name'],
    file_name: row.file_name as string,
    original_name: row.original_name as string,
    mime_type: row.mime_type as string,
    file_size: (row.file_size as number) ?? 0,
    width: (row.width as number) ?? null,
    height: (row.height as number) ?? null,
    created_at: row.created_at as string,
  }
}

export function insertImage(db: Database.Database, args: InsertImageArgs): QuestionImage {
  const id = randomUUID()
  const stmt = db.prepare(`
    INSERT INTO question_images (id, question_id, field_name, file_name, original_name, mime_type, file_size, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(id, args.question_id, args.field_name, args.file_name, args.original_name, args.mime_type, args.file_size, args.width ?? null, args.height ?? null)
  return getImageById(db, id)!
}

export function getImagesForQuestion(db: Database.Database, questionId: string): QuestionImage[] {
  const rows = db.prepare('SELECT * FROM question_images WHERE question_id = ? ORDER BY created_at').all(questionId) as Record<string, unknown>[]
  return rows.map(parseImage)
}

export function getImageById(db: Database.Database, id: string): QuestionImage | null {
  const row = db.prepare('SELECT * FROM question_images WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? parseImage(row) : null
}

export function deleteImageById(db: Database.Database, id: string, imageDir: string): boolean {
  const image = getImageById(db, id)
  if (!image) return false

  const filePath = join(imageDir, image.file_name)
  try {
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch { /* ignore disk errors */ }

  db.prepare('DELETE FROM question_images WHERE id = ?').run(id)
  return true
}

export function deleteImagesForQuestion(db: Database.Database, questionId: string, imageDir: string): number {
  const images = getImagesForQuestion(db, questionId)
  for (const image of images) {
    const filePath = join(imageDir, image.file_name)
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch { /* ignore */ }
  }
  const result = db.prepare('DELETE FROM question_images WHERE question_id = ?').run(questionId)
  return result.changes
}

export function getOrphanedImages(db: Database.Database, imageDir: string): string[] {
  const orphans: string[] = []
  if (!existsSync(imageDir)) return orphans

  const referencedFiles = new Set(
    (db.prepare('SELECT file_name FROM question_images').all() as { file_name: string }[]).map(r => r.file_name)
  )
  const diskFiles = readdirSync(imageDir)
  for (const file of diskFiles) {
    if (!referencedFiles.has(file)) {
      orphans.push(join(imageDir, file))
    }
  }
  return orphans
}

export function deleteOrphanedImages(db: Database.Database, imageDir: string): number {
  const orphans = getOrphanedImages(db, imageDir)
  for (const filePath of orphans) {
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch { /* ignore */ }
  }
  return orphans.length
}

export function copyImageToStorage(sourcePath: string, imageDir: string, imageId: string): string {
  const ext = extname(sourcePath).toLowerCase() || '.png'
  const fileName = `${imageId}${ext}`
  const destPath = join(imageDir, fileName)
  copyFileSync(sourcePath, destPath)
  return fileName
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

export function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}
