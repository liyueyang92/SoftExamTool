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
 * 1. 普通全文查询取 Top-K
 * 2. 根据问题关键词追加 chunk_type='table'/'figure' 查询
 * 3. 合并去重，按加权分数排序
 *
 * Phase 2 新增权重加成：
 *   - is_official=1 的文档块 × 1.5
 *   - chunk_type='text' × 1.2
 *   - chunk_confidence 值作为乘数
 *   - 低置信度 chunk (confidence < minConfidence) 自动排除
 */
export function searchDocChunks(
  db: Database.Database,
  query: string,
  options?: {
    limit?: number
    docId?: string
    preferTypes?: ('table' | 'figure')[]
    minConfidence?: number   // Phase 2: 最低置信度阈值，默认 0.15
  }
): ScoredChunk[] {
  const limit = options?.limit ?? 10
  const preferTypes = options?.preferTypes ?? detectPreferredTypes(query)
  const minConf = options?.minConfidence ?? 0.15
  // Strip HTML tags, then strip FTS5 operator characters (“, *, ^, -)
  // before keeping only CJK/letter/digit/whitespace/safe punctuation.
  // Double quotes (ASCII U+0022 and curly U+201C/201D) are phrase delimiters
  // in FTS5 and must be removed to avoid “unterminated string” errors.
  const ftsQuery = query
    .replace(/<[^>]*>/g,  ' ')
    .replace(/["\u201C\u201D'\u2018\u2019*^]/g, ' ')
    .replace(/[^\p{L}\p{N}\s，。？！：；（）【】、]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!ftsQuery) return []

  console.log(`[searchDocChunks] sanitized query="${ftsQuery.slice(0, 120)}..."`)

  const results: Map<string, ScoredChunk> = new Map()

  // 查询 1：全文检索（置信度过滤）
  try {
    const ftsRows = db.prepare(`
      SELECT c.*, d.title as doc_title, d.is_official, rank
      FROM doc_chunks_fts f
      JOIN doc_chunks c ON c.rowid = f.rowid
      JOIN documents d ON d.id = c.doc_id
      WHERE doc_chunks_fts MATCH ?
        AND (c.confidence IS NULL OR c.confidence >= ?)
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, minConf, limit) as Array<Record<string, unknown> & { rank: number }>
    for (const row of ftsRows) {
      // Phase 2: 计算加权分数
      const baseScore = 1 / (1 + Number(row.rank ?? 1))
      const isOfficial = (row.is_official as number) ?? 0
      const chunkType = (row.chunk_type as string) ?? 'text'
      const conf = (row.confidence as number) ?? null

      let weight = baseScore
      if (isOfficial === 1) weight *= 1.5
      if (chunkType === 'text') weight *= 1.2
      if (conf != null && conf > 0) {
        weight *= (0.5 + conf * 0.5)  // scale to [0.5, 1.0]
      } else {
        weight *= 0.3  // NULL 或 0 confidence 的 chunk 降权
      }

      const chunk: ScoredChunk = {
        id: row.id as string,
        doc_id: row.doc_id as string,
        page_num: row.page_num as number,
        content: row.content as string,
        knowledge_tags: JSON.parse((row.knowledge_tags as string) || '[]'),
        vector_id: (row.vector_id as string) ?? null,
        chunk_type: chunkType as DocChunk['chunk_type'],
        asset_id: (row.asset_id as string) ?? null,
        confidence: conf,
        source_engine: (row.source_engine as string) ?? '',
        block_order: (row.block_order as number) ?? 0,
        bbox: (row.bbox as string) ?? null,
        doc_title: row.doc_title as string,
        _score: weight,
      }
      results.set(chunk.id, chunk)
    }
  } catch (e) {
    console.error('[searchDocChunks] FTS query failed:', e, `query="${ftsQuery.slice(0, 80)}..."`)
  }

  // 查询 2：按类型加权补充（同样过滤低置信度）
  if (preferTypes.length > 0) {
    try {
      const typePlaceholders = preferTypes.map(() => '?').join(',')
      const typeRows = db.prepare(`
        SELECT c.*, d.title as doc_title, d.is_official, 0.5 as rank
        FROM doc_chunks_fts f
        JOIN doc_chunks c ON c.rowid = f.rowid
        JOIN documents d ON d.id = c.doc_id
        WHERE doc_chunks_fts MATCH ?
          AND c.chunk_type IN (${typePlaceholders})
          AND (c.confidence IS NULL OR c.confidence >= ?)
        LIMIT ?
      `).all(ftsQuery, ...preferTypes, minConf, limit * 2) as Array<Record<string, unknown> & { rank: number }>

      for (const row of typeRows) {
        const id = row.id as string
        const isOfficial = (row.is_official as number) ?? 0
        const conf = (row.confidence as number) ?? null
        let weight = 0.3
        if (isOfficial === 1) weight *= 1.5
        if (conf != null && conf > 0) {
          weight *= (0.5 + conf * 0.5)
        } else {
          weight *= 0.3
        }

        if (!results.has(id)) {
          const chunk: ScoredChunk = {
            id: row.id as string,
            doc_id: row.doc_id as string,
            page_num: row.page_num as number,
            content: row.content as string,
            knowledge_tags: JSON.parse((row.knowledge_tags as string) || '[]'),
            vector_id: (row.vector_id as string) ?? null,
            chunk_type: (row.chunk_type as DocChunk['chunk_type']) ?? 'text',
            asset_id: (row.asset_id as string) ?? null,
            confidence: conf,
            source_engine: (row.source_engine as string) ?? '',
            block_order: (row.block_order as number) ?? 0,
            bbox: (row.bbox as string) ?? null,
            doc_title: row.doc_title as string,
            _score: weight,
          }
          results.set(id, chunk)
        } else {
          results.get(id)!._score += weight * 0.5
        }
      }
    } catch (e) {
      console.error('[searchDocChunks] Type-weighted query failed:', e)
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


// ─── Phase 0: Tag cleaning operations ─────────────────────────────────────────

/** 清洗参数（与 Python cleaner 返回结构对齐） */
export interface CleanedChunk {
  id: string
  doc_id: string
  page_num: number
  knowledge_tags: string[]
  confidence: number
  noise_type: string
  action: string
  old_tags: string[]
}

/** 清洗报告 */
export interface CleaningReport {
  total_chunks: number
  actions: Record<string, number>
  noise_cleared: Record<string, number>
  confidence_levels: { high: number; medium: number; low: number; invalid: number }
  confidence_stats: { mean: number; median: number; p10: number; p90: number }
  needs_ai_reclassification: number
}

/** 清洗操作日志 */
export interface CleaningLogEntry {
  id: string
  doc_id: string
  total_chunks: number
  noise_cleared: string
  ai_reclassified: number
  downgraded: number
  populated: number
  unchanged: number
  confidence_stats: string
  snapshot_ids: string
  cleaned_at: string
}

/**
 * 批量更新 chunk 的标签和置信度（清洗结果写入）。
 * 在事务中执行：更新 doc_chunks + 写入 tag_corrections。
 */
export function applyCleanedChunks(
  db: Database.Database,
  cleaned: CleanedChunk[],
): { updated: number; corrections: number } {
  const updateChunk = db.prepare(`
    UPDATE doc_chunks SET knowledge_tags = ?, confidence = ? WHERE id = ?
  `)
  const insertCorrection = db.prepare(`
    INSERT INTO tag_corrections (id, chunk_id, old_tags, new_tags, old_confidence, new_confidence, action, corrected_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let updated = 0
  let corrections = 0

  const apply = db.transaction(() => {
    for (const c of cleaned) {
      if (!c.id) continue
      updateChunk.run(JSON.stringify(c.knowledge_tags), c.confidence, c.id)
      updated++

      // 仅记录有实际变更的修正
      if (c.action && c.action !== 'unchanged') {
        const oldTags = Array.isArray(c.old_tags) ? c.old_tags : []
        const newTags = c.knowledge_tags
        if (JSON.stringify(oldTags) !== JSON.stringify(newTags)) {
          insertCorrection.run(
            randomUUID(),
            c.id,
            JSON.stringify(oldTags),
            JSON.stringify(newTags),
            null,  // old_confidence (unknown at DB level)
            c.confidence,
            c.action,
            'system',
          )
          corrections++
        }
      }
    }
  })
  apply()
  return { updated, corrections }
}

/**
 * 获取指定文档的所有 chunk（含拼接的 metadata），用于发送给 Python 端清洗。
 */
export function getChunksForCleaning(
  db: Database.Database,
  docId: string,
): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT id, doc_id, page_num, content, knowledge_tags, chunk_type, confidence, block_order
    FROM doc_chunks WHERE doc_id = ?
    ORDER BY page_num, block_order
  `).all(docId) as Array<Record<string, unknown>>
}

/**
 * 获取 chunk 的邻居内容（前后各 2 个），用于 AI 重分类上下文。
 */
export function getChunkNeighborContents(
  db: Database.Database,
  docId: string,
  pageNum: number,
  blockOrder: number,
  count: number = 2,
): string[] {
  const rows = db.prepare(`
    SELECT content FROM doc_chunks
    WHERE doc_id = ?
      AND NOT (page_num = ? AND block_order = ?)
      AND (
        (page_num = ? AND block_order BETWEEN ? AND ?) OR
        (page_num = ? AND block_order BETWEEN ? AND ?)
      )
    ORDER BY page_num, block_order
    LIMIT ?
  `).all(
    docId,
    pageNum, blockOrder,
    pageNum, blockOrder - count, blockOrder - 1,  // 前面的
    pageNum, blockOrder + 1, blockOrder + count,  // 后面的
    count * 2,
  ) as Array<{ content: string }>

  return rows.map(r => r.content)
}

/**
 * 写入清洗日志。
 */
export function insertCleaningLog(
  db: Database.Database,
  log: Omit<CleaningLogEntry, 'id' | 'cleaned_at'>,
): CleaningLogEntry {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO cleaning_log (id, doc_id, total_chunks, noise_cleared, ai_reclassified, downgraded, populated, unchanged, confidence_stats, snapshot_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, log.doc_id, log.total_chunks, log.noise_cleared,
    log.ai_reclassified, log.downgraded, log.populated, log.unchanged,
    log.confidence_stats, log.snapshot_ids,
  )
  return db.prepare('SELECT * FROM cleaning_log WHERE id = ?').get(id) as CleaningLogEntry
}

/**
 * 获取文档的清洗历史。
 */
export function getCleaningLogs(
  db: Database.Database,
  docId: string,
): CleaningLogEntry[] {
  return db.prepare(
    'SELECT * FROM cleaning_log WHERE doc_id = ? ORDER BY cleaned_at DESC'
  ).all(docId) as CleaningLogEntry[]
}

/**
 * 回滚指定清洗操作：根据 cleaning_log 关联的 tag_corrections 恢复旧标签。
 */
export function rollbackCleaning(
  db: Database.Database,
  cleaningLogId: string,
): { rolled_back: number } {
  const log = db.prepare('SELECT * FROM cleaning_log WHERE id = ?').get(cleaningLogId) as CleaningLogEntry | undefined
  if (!log) throw new Error(`Cleaning log not found: ${cleaningLogId}`)

  const snapshotIds: string[] = JSON.parse(log.snapshot_ids || '[]')
  if (!snapshotIds.length) throw new Error('No snapshot found for this cleaning operation')

  // 读取修正记录并恢复
  const corrections = db.prepare(`
    SELECT * FROM tag_corrections WHERE id IN (${snapshotIds.map(() => '?').join(',')})
  `).all(...snapshotIds) as Array<{
    id: string; chunk_id: string; old_tags: string; old_confidence: number | null
  }>

  const rollback = db.transaction(() => {
    for (const c of corrections) {
      if (!c.chunk_id) continue
      db.prepare('UPDATE doc_chunks SET knowledge_tags = ?, confidence = ? WHERE id = ?').run(
        c.old_tags, c.old_confidence ?? null, c.chunk_id,
      )
    }
    // 删除修正记录
    db.prepare(`DELETE FROM tag_corrections WHERE id IN (${snapshotIds.map(() => '?').join(',')})`).run(...snapshotIds)
    // 删除清洗日志
    db.prepare('DELETE FROM cleaning_log WHERE id = ?').run(cleaningLogId)
  })
  rollback()
  return { rolled_back: corrections.length }
}

/**
 * 更新单个 chunk 的标签（用于人工修正）。
 */
export function updateChunkTags(
  db: Database.Database,
  chunkId: string,
  tags: string[],
  confidence: number | null,
  correctedBy: string = 'human',
): void {
  const old = db.prepare('SELECT knowledge_tags, confidence FROM doc_chunks WHERE id = ?').get(chunkId) as {
    knowledge_tags: string; confidence: number | null
  } | undefined

  const oldTags = old?.knowledge_tags ?? '[]'
  const oldConf = old?.confidence ?? null

  db.transaction(() => {
    db.prepare('UPDATE doc_chunks SET knowledge_tags = ?, confidence = ? WHERE id = ?').run(
      JSON.stringify(tags), confidence, chunkId,
    )
    db.prepare(`
      INSERT INTO tag_corrections (id, chunk_id, old_tags, new_tags, old_confidence, new_confidence, action, corrected_by)
      VALUES (?, ?, ?, ?, ?, ?, 'human_corrected', ?)
    `).run(randomUUID(), chunkId, oldTags, JSON.stringify(tags), oldConf, confidence, correctedBy)
  })()
}
