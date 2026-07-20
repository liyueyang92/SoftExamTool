import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface KnowledgeDomain {
  id: string
  parent_id: string | null
  name: string
  level: number
  sort_order: number
  suggested_min: number
  weight_pct: number
  is_required: number
  outline_ref: string
  created_at: string
}

export interface KnowledgeDomainTreeNode extends KnowledgeDomain {
  children: KnowledgeDomainTreeNode[]
}

export interface DocDomainMapping {
  domain_id: string
  doc_id: string
  page_range: string
  mapped_at: string
}

function getOutlinePath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'outline-sys-architect.json')
  }
  // Dev: app.getAppPath() returns electron-app/ directory reliably
  return join(app.getAppPath(), '../resources/outline-sys-architect.json')
}

// ─── Queries ───────────────────────────────────────────────────────────────────

export function getDomainById(db: Database.Database, id: string): KnowledgeDomain | null {
  const row = db.prepare('SELECT * FROM knowledge_domains WHERE id = ?').get(id) as KnowledgeDomain | undefined
  return row ?? null
}

export function getDomainsByLevel(db: Database.Database, level: number): KnowledgeDomain[] {
  return db.prepare(
    'SELECT * FROM knowledge_domains WHERE level = ? ORDER BY sort_order ASC'
  ).all(level) as KnowledgeDomain[]
}

export function getChildDomains(db: Database.Database, parentId: string): KnowledgeDomain[] {
  return db.prepare(
    'SELECT * FROM knowledge_domains WHERE parent_id = ? ORDER BY sort_order ASC'
  ).all(parentId) as KnowledgeDomain[]
}

export function getDomainTree(db: Database.Database): KnowledgeDomainTreeNode[] {
  const all = db.prepare(
    'SELECT * FROM knowledge_domains ORDER BY level ASC, sort_order ASC'
  ).all() as KnowledgeDomain[]

  const map = new Map<string, KnowledgeDomainTreeNode>()
  const roots: KnowledgeDomainTreeNode[] = []

  for (const d of all) {
    map.set(d.id, { ...d, children: [] })
  }

  for (const d of all) {
    const node = map.get(d.id)!
    if (d.parent_id && map.has(d.parent_id)) {
      map.get(d.parent_id)!.children.push(node)
    } else if (!d.parent_id) {
      roots.push(node)
    }
  }

  return roots
}

export function getDomainHierarchyPath(db: Database.Database, id: string): KnowledgeDomain[] {
  const path: KnowledgeDomain[] = []
  let current = getDomainById(db, id)
  while (current) {
    path.unshift(current)
    current = current.parent_id ? getDomainById(db, current.parent_id) : null
  }
  return path
}

/** 构建 name → {id, parent_id, name, level} 映射，用于层次去重。 */
export function getDomainNameMap(db: Database.Database): Record<string, { id: string; parent_id: string | null; name: string; level: number }> {
  const all = db.prepare(
    'SELECT id, parent_id, name, level FROM knowledge_domains ORDER BY level, sort_order'
  ).all() as Array<{ id: string; parent_id: string | null; name: string; level: number }>
  const map: Record<string, { id: string; parent_id: string | null; name: string; level: number }> = {}
  for (const d of all) {
    map[d.name] = d
  }
  return map
}

export function getDomainByName(db: Database.Database, name: string): KnowledgeDomain | null {
  const row = db.prepare(
    'SELECT * FROM knowledge_domains WHERE name = ? LIMIT 1'
  ).get(name) as KnowledgeDomain | undefined
  return row ?? null
}

// ─── Mutations ─────────────────────────────────────────────────────────────────

export function upsertDomain(
  db: Database.Database,
  domain: Omit<KnowledgeDomain, 'created_at'>
): KnowledgeDomain {
  const existing = getDomainById(db, domain.id)
  if (existing) {
    db.prepare(`
      UPDATE knowledge_domains
      SET parent_id = ?, name = ?, level = ?, sort_order = ?, suggested_min = ?,
          weight_pct = ?, is_required = ?, outline_ref = ?
      WHERE id = ?
    `).run(
      domain.parent_id, domain.name, domain.level, domain.sort_order,
      domain.suggested_min, domain.weight_pct, domain.is_required,
      domain.outline_ref, domain.id
    )
  } else {
    db.prepare(`
      INSERT INTO knowledge_domains (id, parent_id, name, level, sort_order,
        suggested_min, weight_pct, is_required, outline_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      domain.id, domain.parent_id, domain.name, domain.level, domain.sort_order,
      domain.suggested_min, domain.weight_pct, domain.is_required, domain.outline_ref
    )
  }
  return getDomainById(db, domain.id)!
}

export function deleteDomain(db: Database.Database, id: string): { deleted: number } {
  const info = db.prepare('DELETE FROM knowledge_domains WHERE id = ?').run(id)
  return { deleted: info.changes }
}

// ─── Outline import ────────────────────────────────────────────────────────────

export function importOutline(
  db: Database.Database,
  force = false
): { imported: number; skipped: number } {
  const p = getOutlinePath()
  if (!existsSync(p)) {
    throw new Error(`Outline file not found: ${p}`)
  }

  const raw = JSON.parse(readFileSync(p, 'utf-8')) as Array<{
    id: string; parent_id: string | null; name: string; level: number
    sort_order: number; suggested_min: number; weight_pct: number
    is_required: number; outline_ref: string
  }>

  const existingCount = (db.prepare(
    'SELECT COUNT(*) as cnt FROM knowledge_domains'
  ).get() as { cnt: number }).cnt

  // If force=true, clear existing data before reimport
  if (force && existingCount > 0) {
    db.pragma('foreign_keys = OFF')
    db.prepare('DELETE FROM knowledge_domains').run()
    db.pragma('foreign_keys = ON')
  }

  if (existingCount > 0 && !force) {
    return { imported: 0, skipped: existingCount }
  }

  const insert = db.prepare(`
    INSERT INTO knowledge_domains (id, parent_id, name, level, sort_order,
      suggested_min, weight_pct, is_required, outline_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const importAll = db.transaction(() => {
    for (const item of raw) {
      insert.run(
        item.id, item.parent_id, item.name, item.level, item.sort_order,
        item.suggested_min, item.weight_pct, item.is_required, item.outline_ref
      )
    }
  })

  importAll()
  return { imported: raw.length, skipped: 0 }
}

// ─── Document mapping ──────────────────────────────────────────────────────────

export function getDocMappingsForDomain(
  db: Database.Database,
  domainId: string
): Array<{ doc_id: string; page_range: string }> {
  // Document mappings are inferred from doc_chunks knowledge_tags matching domain name
  const domain = getDomainById(db, domainId)
  if (!domain) return []

  const rows = db.prepare(`
    SELECT DISTINCT d.id as doc_id, d.title
    FROM documents d
    JOIN doc_chunks c ON c.doc_id = d.id
    WHERE c.knowledge_tags LIKE ?
  `).all(`%${domain.name}%`) as Array<{ doc_id: string; title: string }>

  return rows.map((r) => ({ doc_id: r.doc_id, page_range: '' }))
}

export function getLevel1DomainNames(db: Database.Database): string[] {
  const rows = db.prepare(
    'SELECT name FROM knowledge_domains WHERE level = 1 ORDER BY sort_order ASC'
  ).all() as { name: string }[]
  return rows.map((r) => r.name)
}

// ─── Flat list (for parent dropdown & AI context) ───────────────────────────────

export function getFlatDomainList(
  db: Database.Database
): Array<{ id: string; parent_id: string | null; name: string; level: number }> {
  return db.prepare(
    'SELECT id, parent_id, name, level FROM knowledge_domains ORDER BY level, sort_order'
  ).all() as Array<{ id: string; parent_id: string | null; name: string; level: number }>
}

// ─── Batch upsert ──────────────────────────────────────────────────────────────

export function batchUpsertDomains(
  db: Database.Database,
  domains: Array<Omit<KnowledgeDomain, 'created_at'>>
): { inserted: number; updated: number } {
  let inserted = 0
  let updated = 0
  const upsert = db.transaction(() => {
    for (const d of domains) {
      const existing = db.prepare(
        'SELECT id FROM knowledge_domains WHERE id = ?'
      ).get(d.id) as { id: string } | undefined
      if (existing) {
        db.prepare(`
          UPDATE knowledge_domains
          SET parent_id = ?, name = ?, level = ?, sort_order = ?, suggested_min = ?,
              weight_pct = ?, is_required = ?, outline_ref = ?
          WHERE id = ?
        `).run(
          d.parent_id, d.name, d.level, d.sort_order,
          d.suggested_min, d.weight_pct, d.is_required, d.outline_ref, d.id
        )
        updated++
      } else {
        db.prepare(`
          INSERT INTO knowledge_domains (id, parent_id, name, level, sort_order,
            suggested_min, weight_pct, is_required, outline_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          d.id, d.parent_id, d.name, d.level, d.sort_order,
          d.suggested_min, d.weight_pct, d.is_required, d.outline_ref
        )
        inserted++
      }
    }
  })
  upsert()
  return { inserted, updated }
}

// ─── Chunks for multiple documents ─────────────────────────────────────────────

// ─── Domain tree text formatter (for AI prompts) ─────────────────────────────

/**
 * 将知识领域树格式化为缩进文本，用于 AI 分类 prompt。
 * 示例输出：
 *   · 计算机组成与体系结构
 *     - 存储系统
 *       · Cache映射方式（直接/组相联/全相联）
 */
export function formatDomainTreeAsText(db: Database.Database): string {
  const tree = getDomainTree(db)
  const lines: string[] = []

  function walk(nodes: KnowledgeDomainTreeNode[], indent: number) {
    for (const node of nodes) {
      const prefix = '  '.repeat(indent) + (node.level === 1 ? '· ' : node.level === 2 ? '- ' : '  · ')
      lines.push(`${prefix}${node.name}`)
      if (node.children.length > 0) {
        walk(node.children, indent + 1)
      }
    }
  }

  walk(tree, 0)
  return lines.join('\n')
}

export function getChunksForDocuments(
  db: Database.Database,
  docIds: string[]
): Array<{ id: string; doc_id: string; page_num: number; content: string; knowledge_tags: string }> {
  if (!docIds.length) return []
  const placeholders = docIds.map(() => '?').join(',')
  return db.prepare(`
    SELECT id, doc_id, page_num, content, knowledge_tags
    FROM doc_chunks
    WHERE doc_id IN (${placeholders})
    ORDER BY doc_id, page_num, block_order
  `).all(...docIds) as Array<{
    id: string; doc_id: string; page_num: number; content: string; knowledge_tags: string
  }>
}
