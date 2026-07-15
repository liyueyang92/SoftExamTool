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
  is_official: number
}

export interface DocChunk {
  id: string
  doc_id: string
  page_num: number
  content: string
  knowledge_tags: string[]
  vector_id: string | null
  chunk_type: 'text' | 'table' | 'figure' | 'page_summary'
  asset_id: string | null
  confidence: number | null
  source_engine: string
  block_order: number
  bbox: string | null
}

export interface DocAsset {
  id: string
  doc_id: string
  page_num: number
  asset_type: 'page_image' | 'embedded_image' | 'figure_crop' | 'table_crop'
  file_path: string
  width: number
  height: number
  bbox: string
  content_hash: string
  created_at: string
}

export function listDocuments(db: Database.Database): Document[] {
  return db.prepare('SELECT * FROM documents ORDER BY is_official DESC, imported_at DESC').all() as Document[]
}

export function getDocumentByMd5(db: Database.Database, md5: string): Document | null {
  return (db.prepare('SELECT * FROM documents WHERE md5 = ?').get(md5) as Document) ?? null
}

export function getDocumentById(db: Database.Database, id: string): Document | null {
  return (db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Document) ?? null
}

export function insertDocument(db: Database.Database, doc: Omit<Document, 'id' | 'imported_at' | 'is_official'>): Document {
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

/** 设置某文档为官方教材（全局唯一，其余自动取消） */
export function setDocumentOfficial(db: Database.Database, id: string, isOfficial: boolean): void {
  if (isOfficial) {
    db.transaction(() => {
      // 取消所有已有标记
      db.prepare("UPDATE documents SET is_official = 0 WHERE is_official = 1").run()
      // 设置目标文档
      db.prepare("UPDATE documents SET is_official = 1 WHERE id = ?").run(id)
    })()
  } else {
    db.prepare("UPDATE documents SET is_official = 0 WHERE id = ?").run(id)
  }
}

/** 获取官方教材（如有） */
export function getOfficialDocument(db: Database.Database): Document | null {
  const row = db.prepare(
    "SELECT * FROM documents WHERE is_official = 1 LIMIT 1"
  ).get() as Document | undefined
  return row ?? null
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
  chunks: Array<{
    doc_id: string
    page_num: number
    content: string
    knowledge_tags: string[]
    chunk_type?: string
    asset_id?: string | null
    confidence?: number | null
    source_engine?: string
    block_order?: number
    bbox?: string | null
  }>
): number {
  const stmt = db.prepare(`
    INSERT INTO doc_chunks (id, doc_id, page_num, content, knowledge_tags,
      chunk_type, asset_id, confidence, source_engine, block_order, bbox)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertAll = db.transaction(() => {
    for (const c of chunks) {
      stmt.run(
        randomUUID(),
        c.doc_id,
        c.page_num,
        c.content,
        JSON.stringify(c.knowledge_tags),
        c.chunk_type ?? 'text',
        c.asset_id ?? null,
        c.confidence ?? null,
        c.source_engine ?? '',
        c.block_order ?? 0,
        c.bbox != null ? (typeof c.bbox === 'string' ? c.bbox : JSON.stringify(c.bbox)) : null,
      )
    }
  })
  insertAll()
  return chunks.length
}

export function deleteDocChunks(db: Database.Database, docId: string): void {
  db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId)
}

export function deleteDocChunksByPage(
  db: Database.Database,
  docId: string,
  pageNum: number
): void {
  db.prepare('DELETE FROM doc_chunks WHERE doc_id = ? AND page_num = ?').run(docId, pageNum)
}

export function getDocChunkCount(db: Database.Database, docId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM doc_chunks WHERE doc_id = ?').get(docId) as { count: number }
  return row.count
}

export function getChunks(db: Database.Database, docId: string): DocChunk[] {
  const rows = db.prepare('SELECT * FROM doc_chunks WHERE doc_id = ? ORDER BY page_num, block_order').all(docId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    ...r,
    knowledge_tags: JSON.parse((r.knowledge_tags as string) || '[]'),
    chunk_type: (r.chunk_type as string) ?? 'text',
    asset_id: (r.asset_id as string) ?? null,
    confidence: (r.confidence as number) ?? null,
    source_engine: (r.source_engine as string) ?? '',
    block_order: (r.block_order as number) ?? 0,
    bbox: (r.bbox as string) ?? null,
  })) as DocChunk[]
}

export function insertAssets(
  db: Database.Database,
  assets: Array<{
    id: string
    doc_id: string
    page_num: number
    asset_type: string
    file_path: string
    width: number
    height: number
    bbox: string
    content_hash: string
  }>
): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO doc_assets (id, doc_id, page_num, asset_type, file_path, width, height, bbox, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertAll = db.transaction(() => {
    for (const a of assets) {
      stmt.run(a.id, a.doc_id, a.page_num, a.asset_type, a.file_path, a.width, a.height, a.bbox, a.content_hash)
    }
  })
  insertAll()
  return assets.length
}

export function deleteDocAssets(db: Database.Database, docId: string): void {
  db.prepare('DELETE FROM doc_assets WHERE doc_id = ?').run(docId)
}

export function deleteDocAssetsByPage(
  db: Database.Database,
  docId: string,
  pageNum: number
): void {
  db.prepare('DELETE FROM doc_assets WHERE doc_id = ? AND page_num = ?').run(docId, pageNum)
}

export function getDocAssets(db: Database.Database, docId: string): DocAsset[] {
  return db.prepare('SELECT * FROM doc_assets WHERE doc_id = ? ORDER BY page_num').all(docId) as DocAsset[]
}

/** FTS search result with score. */
export interface ScoredChunk extends DocChunk {
  doc_title: string
  _score: number
}

/**
 * Detect which chunk types to boost based on question keywords.
 */
export function detectPreferredTypes(query: string): ('table' | 'figure')[] {
  const lower = query.toLowerCase()
  const types: ('table' | 'figure')[] = []

  const tableKeywords = ['对比', '区别', '优缺点', '核心特点', '阶段', '分类', '类型', '方案', '特点', '比较', '优缺点', '对比分析']
  const figureKeywords = ['流程', '关系', '结构', '包含', '属于', '方向', '图', '架构', '层次', '组成', '层级', '分类关系']

  if (tableKeywords.some(k => lower.includes(k))) types.push('table')
  if (figureKeywords.some(k => lower.includes(k))) types.push('figure')

  return types
}

/**
 * 多路加权检索 doc_chunks。
 * 1. 普通全文查询取 Top 5
 * 2. 根据问题关键词追加 chunk_type='table'/'figure' 查询
 * 3. 合并去重，按简单分数排序
 */
export function searchDocChunks(
  db: Database.Database,
  query: string,
  options?: {
    limit?: number
    docId?: string
    preferTypes?: ('table' | 'figure')[]
  }
): ScoredChunk[] {
  const limit = options?.limit ?? 5
  const preferTypes = options?.preferTypes ?? detectPreferredTypes(query)
  const ftsQuery = query.replace(/["']/g, ' ')

  const results: Map<string, ScoredChunk> = new Map()

  // 查询 1：全文检索
  try {
    const ftsRows = db.prepare(`
      SELECT c.*, d.title as doc_title, rank
      FROM doc_chunks_fts f
      JOIN doc_chunks c ON c.rowid = f.rowid
      JOIN documents d ON d.id = c.doc_id
      WHERE doc_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<Record<string, unknown> & { rank: number }>

    for (const row of ftsRows) {
      const chunk = {
        id: row.id as string,
        doc_id: row.doc_id as string,
        page_num: row.page_num as number,
        content: row.content as string,
        knowledge_tags: JSON.parse((row.knowledge_tags as string) || '[]'),
        vector_id: (row.vector_id as string) ?? null,
        chunk_type: (row.chunk_type as DocChunk['chunk_type']) ?? 'text',
        asset_id: (row.asset_id as string) ?? null,
        confidence: (row.confidence as number) ?? null,
        source_engine: (row.source_engine as string) ?? '',
        block_order: (row.block_order as number) ?? 0,
        bbox: (row.bbox as string) ?? null,
        doc_title: row.doc_title as string,
        _score: 1 / (1 + Number(row.rank ?? 1)),
      }
      results.set(chunk.id, chunk)
    }
  } catch {
    // FTS table may not exist (legacy compatibility)
  }

  // 查询 2：按类型加权补充
  if (preferTypes.length > 0) {
    try {
      const typePlaceholders = preferTypes.map(() => '?').join(',')
      const typeRows = db.prepare(`
        SELECT c.*, d.title as doc_title, 0.5 as rank
        FROM doc_chunks_fts f
        JOIN doc_chunks c ON c.rowid = f.rowid
        JOIN documents d ON d.id = c.doc_id
        WHERE doc_chunks_fts MATCH ? AND c.chunk_type IN (${typePlaceholders})
        LIMIT ?
      `).all(ftsQuery, ...preferTypes, limit * 2) as Array<Record<string, unknown> & { rank: number }>

      for (const row of typeRows) {
        const id = row.id as string
        if (!results.has(id)) {
          const chunk = {
            id: row.id as string,
            doc_id: row.doc_id as string,
            page_num: row.page_num as number,
            content: row.content as string,
            knowledge_tags: JSON.parse((row.knowledge_tags as string) || '[]'),
            vector_id: (row.vector_id as string) ?? null,
            chunk_type: (row.chunk_type as DocChunk['chunk_type']) ?? 'text',
            asset_id: (row.asset_id as string) ?? null,
            confidence: (row.confidence as number) ?? null,
            source_engine: (row.source_engine as string) ?? '',
            block_order: (row.block_order as number) ?? 0,
            bbox: (row.bbox as string) ?? null,
            doc_title: row.doc_title as string,
            _score: 0.3,
          }
          results.set(id, chunk)
        } else {
          results.get(id)!._score += 0.2
        }
      }
    } catch {
      // type-weighted query failed, fall back to base results
    }
  }

  return Array.from(results.values())
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
}

export function updateChunkContent(
  db: Database.Database,
  chunkId: string,
  content: string,
): void {
  db.prepare('UPDATE doc_chunks SET content = ? WHERE id = ?').run(content, chunkId)
}
