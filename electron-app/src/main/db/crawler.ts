import type { Database } from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'

export interface CrawlerRule {
  id: string
  site_name: string
  url_template: string
  item_selector: string
  question_field: string
  options_field: string | null
  answer_field: string | null
  expl_field: string | null
  max_pages: number
  delay_ms: number
  is_enabled: number
  total_crawled: number
  last_run_at: string | null
  created_at: string
}

export interface CrawlerRun {
  id: string
  rule_id: string
  status: string
  total_found: number
  total_saved: number
  started_at: string
  ended_at: string | null
  error_msg: string | null
}

export function listCrawlerRules(db: Database): CrawlerRule[] {
  return db.prepare('SELECT * FROM crawler_rules ORDER BY created_at DESC').all() as CrawlerRule[]
}

export function upsertCrawlerRule(
  db: Database,
  rule: Omit<CrawlerRule, 'id' | 'created_at' | 'total_crawled' | 'last_run_at'> & { id?: string }
): CrawlerRule {
  const id = rule.id ?? randomUUID()
  if (rule.id) {
    db.prepare(`
      UPDATE crawler_rules SET
        site_name=?, url_template=?, item_selector=?, question_field=?,
        options_field=?, answer_field=?, expl_field=?, max_pages=?, delay_ms=?, is_enabled=?
      WHERE id=?
    `).run(
      rule.site_name, rule.url_template, rule.item_selector, rule.question_field,
      rule.options_field ?? null, rule.answer_field ?? null, rule.expl_field ?? null,
      rule.max_pages, rule.delay_ms, rule.is_enabled, id
    )
  } else {
    db.prepare(`
      INSERT INTO crawler_rules
        (id, site_name, url_template, item_selector, question_field,
         options_field, answer_field, expl_field, max_pages, delay_ms, is_enabled)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, rule.site_name, rule.url_template, rule.item_selector, rule.question_field,
      rule.options_field ?? null, rule.answer_field ?? null, rule.expl_field ?? null,
      rule.max_pages, rule.delay_ms, rule.is_enabled
    )
  }
  return db.prepare('SELECT * FROM crawler_rules WHERE id=?').get(id) as CrawlerRule
}

export function deleteCrawlerRule(db: Database, id: string): void {
  db.prepare('DELETE FROM crawler_rules WHERE id=?').run(id)
}

export function createCrawlerRun(db: Database, ruleId: string): CrawlerRun {
  const id = randomUUID()
  db.prepare('INSERT INTO crawler_runs (id, rule_id) VALUES (?,?)').run(id, ruleId)
  return db.prepare('SELECT * FROM crawler_runs WHERE id=?').get(id) as CrawlerRun
}

export function updateCrawlerRun(
  db: Database,
  id: string,
  patch: { status?: string; total_found?: number; total_saved?: number; ended_at?: string; error_msg?: string }
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
