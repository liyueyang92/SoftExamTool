import type { Database } from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'
import type { QuestionInput } from './questions'
import type { QuestionGroup } from './question-groups'

export interface CrawlerRule {
  id: string
  site_name: string
  adapter: CrawlerAdapter
  auth_required: number
  auth_mode: CrawlerAuthMode
  login_url: string | null
  validate_url: string | null
  url_template: string
  item_selector: string
  question_field: string
  options_field: string | null
  answer_field: string | null
  expl_field: string | null
  rule_json: string
  version: number
  max_pages: number
  delay_ms: number
  is_enabled: number
  total_crawled: number
  last_run_at: string | null
  created_at: string
  updated_at: string
}

export interface CrawlerRun {
  id: string
  rule_id: string
  status: string
  total_found: number
  total_saved: number
  target_group_id: string | null
  started_at: string
  ended_at: string | null
  error_code: string | null
  error_stage: string | null
  error_msg: string | null
}

export type CrawlerAdapter = 'http_rule' | 'browser_rule' | 'api_json' | 'feed_import' | 'manual_clip'
export type CrawlerAuthMode = 'none' | 'manual_session'
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'imported'

export interface CrawlerSiteSession {
  id: string
  site_id: string
  site_name: string
  account_alias: string
  auth_mode: CrawlerAuthMode
  encrypted_state: Buffer
  storage_meta: string
  last_validated_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface CrawlerSessionPublic {
  id: string
  site_id: string
  site_name: string
  account_alias: string
  auth_mode: CrawlerAuthMode
  storage_meta: Record<string, unknown>
  last_validated_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface NormalizedCrawlerPayload extends QuestionInput {
  title?: string | null
  content_hash?: string
  source_site?: string | null
  raw?: unknown
}

export interface CrawlerReviewItem {
  id: string
  rule_id: string
  run_id: string
  content_hash: string
  normalized_payload: string
  target_group_id: string | null
  target_group_snapshot: string | null
  review_status: ReviewStatus
  review_notes: string
  created_at: string
  updated_at: string
}

export interface ParsedCrawlerReviewItem extends Omit<CrawlerReviewItem, 'normalized_payload' | 'target_group_snapshot'> {
  normalized_payload: NormalizedCrawlerPayload
  target_group_snapshot: Pick<QuestionGroup, 'id' | 'name' | 'group_type' | 'exam_year' | 'exam_period'> | null
}

function toRuleJson(rule: Partial<CrawlerRule>): string {
  if (typeof rule.rule_json === 'string' && rule.rule_json.trim()) return rule.rule_json
  return JSON.stringify({
    list: {
      url_template: rule.url_template ?? '',
      item_selector: rule.item_selector ?? '',
      fields: {
        content: rule.question_field ?? '',
        options: rule.options_field ?? '',
        answer: rule.answer_field ?? '',
        explanation: rule.expl_field ?? '',
      },
    },
    pagination: {
      type: 'page_param',
      max_pages: rule.max_pages ?? 5,
    },
    request: {
      delay_ms: rule.delay_ms ?? 1500,
    },
  })
}

function parseReviewItem(row: CrawlerReviewItem): ParsedCrawlerReviewItem {
  return {
    ...row,
    normalized_payload: JSON.parse(row.normalized_payload) as NormalizedCrawlerPayload,
    target_group_snapshot: row.target_group_snapshot
      ? JSON.parse(row.target_group_snapshot) as ParsedCrawlerReviewItem['target_group_snapshot']
      : null,
  }
}

function parseSession(row: CrawlerSiteSession): CrawlerSessionPublic {
  return {
    id: row.id,
    site_id: row.site_id,
    site_name: row.site_name,
    account_alias: row.account_alias,
    auth_mode: row.auth_mode,
    storage_meta: row.storage_meta ? JSON.parse(row.storage_meta) as Record<string, unknown> : {},
    last_validated_at: row.last_validated_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listCrawlerRules(db: Database): CrawlerRule[] {
  return db.prepare('SELECT * FROM crawler_rules ORDER BY created_at DESC').all() as CrawlerRule[]
}

export function upsertCrawlerRule(
  db: Database,
  rule: Omit<CrawlerRule, 'id' | 'created_at' | 'updated_at' | 'total_crawled' | 'last_run_at'> & { id?: string }
): CrawlerRule {
  const id = rule.id ?? randomUUID()
  const now = new Date().toISOString()
  const adapter = rule.adapter ?? 'http_rule'
  const authRequired = rule.auth_required ? 1 : 0
  const authMode = rule.auth_mode ?? (authRequired ? 'manual_session' : 'none')
  const ruleJson = toRuleJson(rule)
  if (rule.id) {
    db.prepare(`
      UPDATE crawler_rules SET
        site_name=?, url_template=?, item_selector=?, question_field=?,
        options_field=?, answer_field=?, expl_field=?, max_pages=?, delay_ms=?, is_enabled=?,
        adapter=?, auth_required=?, auth_mode=?, login_url=?, validate_url=?,
        rule_json=?, version=version+1, updated_at=?
      WHERE id=?
    `).run(
      rule.site_name, rule.url_template, rule.item_selector, rule.question_field,
      rule.options_field ?? null, rule.answer_field ?? null, rule.expl_field ?? null,
      rule.max_pages, rule.delay_ms, rule.is_enabled,
      adapter, authRequired, authMode, rule.login_url ?? null, rule.validate_url ?? null,
      ruleJson, now, id
    )
  } else {
    db.prepare(`
      INSERT INTO crawler_rules
        (id, site_name, url_template, item_selector, question_field,
         options_field, answer_field, expl_field, max_pages, delay_ms, is_enabled,
         adapter, auth_required, auth_mode, login_url, validate_url, rule_json, version, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, rule.site_name, rule.url_template, rule.item_selector, rule.question_field,
      rule.options_field ?? null, rule.answer_field ?? null, rule.expl_field ?? null,
      rule.max_pages, rule.delay_ms, rule.is_enabled,
      adapter, authRequired, authMode, rule.login_url ?? null, rule.validate_url ?? null,
      ruleJson, rule.version ?? 1, now
    )
  }
  return db.prepare('SELECT * FROM crawler_rules WHERE id=?').get(id) as CrawlerRule
}

export function deleteCrawlerRule(db: Database, id: string): void {
  db.prepare('DELETE FROM crawler_rules WHERE id=?').run(id)
}

export function createCrawlerRun(db: Database, ruleId: string, targetGroupId?: string | null): CrawlerRun {
  const id = randomUUID()
  db.prepare('INSERT INTO crawler_runs (id, rule_id, target_group_id) VALUES (?,?,?)').run(id, ruleId, targetGroupId ?? null)
  return db.prepare('SELECT * FROM crawler_runs WHERE id=?').get(id) as CrawlerRun
}

export function updateCrawlerRun(
  db: Database,
  id: string,
  patch: {
    status?: string
    total_found?: number
    total_saved?: number
    ended_at?: string
    error_code?: string
    error_stage?: string
    error_msg?: string
  }
): void {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) { sets.push(`${k}=?`); vals.push(v) }
  }
  if (sets.length) db.prepare(`UPDATE crawler_runs SET ${sets.join(',')} WHERE id=?`).run(...vals, id)
}

export function listCrawlerRuns(db: Database, ruleId: string): CrawlerRun[] {
  return db.prepare(
    'SELECT * FROM crawler_runs WHERE rule_id=? ORDER BY started_at DESC LIMIT 20'
  ).all(ruleId) as CrawlerRun[]
}

export function addCrawledCount(db: Database, ruleId: string, count: number): void {
  db.prepare(
    'UPDATE crawler_rules SET total_crawled=total_crawled+?, last_run_at=? WHERE id=?'
  ).run(count, new Date().toISOString(), ruleId)
}

export function saveCrawlerReviewItems(
  db: Database,
  args: {
    ruleId: string
    runId: string
    items: NormalizedCrawlerPayload[]
    targetGroupId?: string | null
  }
): number {
  const targetGroup = args.targetGroupId
    ? db.prepare('SELECT id, name, group_type, exam_year, exam_period FROM question_groups WHERE id=?')
        .get(args.targetGroupId) as ParsedCrawlerReviewItem['target_group_snapshot']
    : null
  const targetSnapshot = targetGroup ? JSON.stringify(targetGroup) : null
  const now = new Date().toISOString()
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO crawler_review_items
      (id, rule_id, run_id, content_hash, normalized_payload, target_group_id, target_group_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insert = db.transaction((items: NormalizedCrawlerPayload[]) => {
    let inserted = 0
    for (const item of items) {
      const hash = item.content_hash
      if (!hash) continue
      const result = stmt.run(
        randomUUID(),
        args.ruleId,
        args.runId,
        hash,
        JSON.stringify(item),
        args.targetGroupId ?? null,
        targetSnapshot,
        now,
        now
      )
      inserted += result.changes
    }
    return inserted
  })
  return insert(args.items) as number
}

export function listCrawlerReviewItems(
  db: Database,
  filter: { status?: ReviewStatus; ruleId?: string; runId?: string; limit?: number } = {}
): ParsedCrawlerReviewItem[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter.status) { conditions.push('review_status = ?'); params.push(filter.status) }
  if (filter.ruleId) { conditions.push('rule_id = ?'); params.push(filter.ruleId) }
  if (filter.runId) { conditions.push('run_id = ?'); params.push(filter.runId) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT *
    FROM crawler_review_items
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, filter.limit ?? 100) as CrawlerReviewItem[]
  return rows.map(parseReviewItem)
}

export function updateCrawlerReviewStatus(
  db: Database,
  ids: string[],
  status: ReviewStatus,
  notes = ''
): void {
  if (!ids.length) return
  const stmt = db.prepare(`
    UPDATE crawler_review_items
    SET review_status = ?, review_notes = ?, updated_at = ?
    WHERE id = ?
  `)
  const update = db.transaction((itemIds: string[]) => {
    for (const id of itemIds) stmt.run(status, notes, new Date().toISOString(), id)
  })
  update(ids)
}

export function getCrawlerReviewItemsByIds(db: Database, ids: string[]): ParsedCrawlerReviewItem[] {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT *
    FROM crawler_review_items
    WHERE id IN (${placeholders})
  `).all(...ids) as CrawlerReviewItem[]
  return rows.map(parseReviewItem)
}

export function upsertCrawlerSiteSession(
  db: Database,
  input: {
    site_id: string
    site_name: string
    account_alias: string
    auth_mode?: CrawlerAuthMode
    encrypted_state: Buffer
    storage_meta?: Record<string, unknown>
    expires_at?: string | null
  }
): CrawlerSessionPublic {
  const now = new Date().toISOString()
  const existing = db.prepare(`
    SELECT id
    FROM crawler_site_sessions
    WHERE site_id = ? AND account_alias = ?
  `).get(input.site_id, input.account_alias) as { id: string } | undefined

  if (existing) {
    db.prepare(`
      UPDATE crawler_site_sessions
      SET site_name = ?, auth_mode = ?, encrypted_state = ?, storage_meta = ?,
          expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.site_name,
      input.auth_mode ?? 'manual_session',
      input.encrypted_state,
      JSON.stringify(input.storage_meta ?? {}),
      input.expires_at ?? null,
      now,
      existing.id,
    )
    return parseSession(db.prepare('SELECT * FROM crawler_site_sessions WHERE id=?').get(existing.id) as CrawlerSiteSession)
  }

  const id = randomUUID()
  db.prepare(`
    INSERT INTO crawler_site_sessions
      (id, site_id, site_name, account_alias, auth_mode, encrypted_state, storage_meta, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.site_id,
    input.site_name,
    input.account_alias,
    input.auth_mode ?? 'manual_session',
    input.encrypted_state,
    JSON.stringify(input.storage_meta ?? {}),
    input.expires_at ?? null,
    now,
    now,
  )
  return parseSession(db.prepare('SELECT * FROM crawler_site_sessions WHERE id=?').get(id) as CrawlerSiteSession)
}

export function listCrawlerSiteSessions(db: Database, siteId?: string): CrawlerSessionPublic[] {
  const rows = siteId
    ? db.prepare('SELECT * FROM crawler_site_sessions WHERE site_id=? ORDER BY updated_at DESC').all(siteId)
    : db.prepare('SELECT * FROM crawler_site_sessions ORDER BY updated_at DESC').all()
  return (rows as CrawlerSiteSession[]).map(parseSession)
}

export function getCrawlerSiteSession(db: Database, siteId: string, accountAlias: string): CrawlerSiteSession | null {
  return db.prepare(`
    SELECT *
    FROM crawler_site_sessions
    WHERE site_id = ? AND account_alias = ?
  `).get(siteId, accountAlias) as CrawlerSiteSession | null
}

export function touchCrawlerSiteSessionValidation(db: Database, siteId: string, accountAlias: string): void {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE crawler_site_sessions
    SET last_validated_at = ?, updated_at = ?
    WHERE site_id = ? AND account_alias = ?
  `).run(now, now, siteId, accountAlias)
}

export function deleteCrawlerSiteSession(db: Database, siteId: string, accountAlias: string): void {
  db.prepare('DELETE FROM crawler_site_sessions WHERE site_id=? AND account_alias=?').run(siteId, accountAlias)
}
