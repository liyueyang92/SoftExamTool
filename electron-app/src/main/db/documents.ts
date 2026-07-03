import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'
import { isAbsolute, normalize, relative, resolve } from 'path'

export interface Document {
  id: string
  title: string
  file_path: string
  page_count: number
  md5: string
  imported_at: string
}

export interface DocChunk {
  id: string
  doc_id: string
  page_num: number
  content: string
  knowledge_tags: string[]
  vector_id: string | null
}

export function listDocuments(db: Database.Database): Document[] {
  return db.prepare('SELECT * FROM documents ORDER BY imported_at DESC').all() as Document[]
}

export function getDocumentByMd5(db: Database.Database, md5: string): Document | null {
  return (db.prepare('SELECT * FROM documents WHERE md5 = ?').get(md5) as Document) ?? null
}

export function getDocumentById(db: Database.Database, id: string): Document | null {
  return (db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Document) ?? null
}

export function insertDocument(db: Database.Database, doc: Omit<Document, 'id' | 'imported_at'>): Document {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO documents (id, title, file_path, page_count, md5)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, doc.title, doc.file_path, doc.page_count, doc.md5)
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Document
}

export function updateDocumentPageCount(db: Database.Database, id: string, pageCount: number): void {
  db.prepare('UPDATE documents SET page_count = ? WHERE id = ?').run(pageCount, id)
}

export function deleteDocument(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
}

function isPathInsideDirectory(filePath: string, dirPath: string): boolean {
  const absoluteFile = normalize(resolve(filePath))
  const absoluteDir = normalize(resolve(dirPath))
  const rel = relative(absoluteDir, absoluteFile)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function remapManagedDocumentPaths(
  db: Database.Database,
  fromDir: string,
  toDir: string,
): number {
  const docs = db.prepare('SELECT id, file_path FROM documents').all() as Array<{ id: string; file_path: string }>
  const updateStmt = db.prepare('UPDATE documents SET file_path = ? WHERE id = ?')
  let changed = 0

  const updateAll = db.transaction(() => {
    for (const doc of docs) {
      if (!isPathInsideDirectory(doc.file_path, fromDir)) continue
      const rel = relative(resolve(fromDir), resolve(doc.file_path))
      updateStmt.run(resolve(toDir, rel), doc.id)
      changed += 1
    }
  })
  updateAll()

  return changed
}

export function insertChunks(
  db: Database.Database,
  chunks: Array<{ doc_id: string; page_num: number; content: string; knowledge_tags: string[] }>
): number {
  const stmt = db.prepare(`
    INSERT INTO doc_chunks (id, doc_id, page_num, content, knowledge_tags)
    VALUES (?, ?, ?, ?, ?)
  `)
  const insertAll = db.transaction(() => {
    for (const c of chunks) {
      stmt.run(randomUUID(), c.doc_id, c.page_num, c.content, JSON.stringify(c.knowledge_tags))
    }
  })
  insertAll()
  return chunks.length
}

export function deleteDocChunks(db: Database.Database, docId: string): void {
  db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId)
}

export function getDocChunkCount(db: Database.Database, docId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM doc_chunks WHERE doc_id = ?').get(docId) as { count: number }
  return row.count
}

export function getChunks(db: Database.Database, docId: string): DocChunk[] {
  const rows = db.prepare('SELECT * FROM doc_chunks WHERE doc_id = ? ORDER BY page_num').all(docId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    ...r,
    knowledge_tags: JSON.parse((r.knowledge_tags as string) || '[]'),
  })) as DocChunk[]
}
