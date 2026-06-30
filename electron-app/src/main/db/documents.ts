import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

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

export function getChunks(db: Database.Database, docId: string): DocChunk[] {
  const rows = db.prepare('SELECT * FROM doc_chunks WHERE doc_id = ? ORDER BY page_num').all(docId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    ...r,
    knowledge_tags: JSON.parse((r.knowledge_tags as string) || '[]'),
  })) as DocChunk[]
}
