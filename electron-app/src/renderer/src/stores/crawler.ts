import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toIpcPayload } from '../utils/ipc'

export interface CrawlerRule {
  id: string
  site_name: string
  adapter: 'http_rule' | 'browser_rule' | 'api_json' | 'feed_import' | 'manual_clip'
  auth_required: number
  auth_mode: 'none' | 'manual_session'
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

export interface CrawlerReviewItem {
  id: string
  rule_id: string
  run_id: string
  content_hash: string
  normalized_payload: {
    title?: string | null
    content: string
    type: 'single' | 'multiple' | 'case' | 'essay'
    options?: string[] | null
    answer?: string | null
    explanation?: string | null
    source_url?: string | null
    source_site?: string | null
  }
  target_group_id: string | null
  target_group_snapshot: unknown | null
  review_status: 'pending' | 'approved' | 'rejected' | 'imported'
  review_notes: string
  created_at: string
  updated_at: string
}

export interface CrawlerSession {
  id: string
  site_id: string
  site_name: string
  account_alias: string
  auth_mode: 'none' | 'manual_session'
  storage_meta: Record<string, unknown>
  last_validated_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface NewCrawlerTargetGroup {
  name: string
  group_type?: 'custom' | 'past_exam' | 'ai_generated' | 'crawled' | 'manual_import'
  exam_year?: number | null
  exam_period?: 'H1' | 'H2' | null
  description?: string
}

export interface CrawlerInspectNode {
  path: string
  selector: string
  tag: string
  text: string
  classes: string[]
  id?: string | null
  match_count: number
}

export interface CrawlerInspectLoadResult {
  url: string
  adapter: CrawlerRule['adapter']
  html: string
  title: string
  nodes: CrawlerInspectNode[]
}

export interface CrawlerSelectorCandidate {
  selector: string
  match_count: number
  text_sample: string
  stability: 'high' | 'medium' | 'low'
}

export interface CrawlerInspectPreviewResult {
  count: number
  samples: unknown[]
  selector_matches: Record<string, number>
}

export interface CrawlerSessionValidationResult {
  valid: boolean
  status?: number
  message?: string
  checks?: Array<{ name: string; valid: boolean; message: string }>
}

export const useCrawlerStore = defineStore('crawler', () => {
  const rules = ref<CrawlerRule[]>([])
  const loading = ref(false)
  const runs = ref<CrawlerRun[]>([])
  const reviewItems = ref<CrawlerReviewItem[]>([])
  const sessions = ref<CrawlerSession[]>([])
  const activeRuleId = ref<string | null>(null)

  async function fetchRules() {
    loading.value = true
    try {
      const res = await window.electronAPI.listCrawlerRules()
      if (res.success) rules.value = res.data as CrawlerRule[]
    } finally {
      loading.value = false
    }
  }

  async function upsert(rule: Partial<CrawlerRule>): Promise<CrawlerRule> {
    const res = await window.electronAPI.upsertCrawlerRule(toIpcPayload(rule))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const updated = res.data as CrawlerRule
    const idx = rules.value.findIndex((r) => r.id === updated.id)
    if (idx >= 0) rules.value[idx] = updated
    else rules.value.unshift(updated)
    return updated
  }

  async function remove(id: string) {
    await window.electronAPI.deleteCrawlerRule(id)
    rules.value = rules.value.filter((r) => r.id !== id)
    if (activeRuleId.value === id) activeRuleId.value = null
  }

  async function testCrawl(rule: Partial<CrawlerRule>, testUrl: string, accountAlias?: string | null) {
    const res = await window.electronAPI.testCrawl(toIpcPayload({
      rule,
      test_url: testUrl,
      account_alias: accountAlias,
    }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return res.data
  }

  async function run(args: {
    ruleId: string
    target_group_id?: string | null
    new_group?: NewCrawlerTargetGroup | null
    account_alias?: string | null
  }) {
    const res = await window.electronAPI.runCrawl(toIpcPayload(args))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return res.data
  }

  async function fetchRuns(ruleId: string) {
    const res = await window.electronAPI.listCrawlerRuns(ruleId)
    if (res.success) runs.value = res.data as CrawlerRun[]
  }

  async function startAuth(ruleId: string, accountAlias: string) {
    const res = await window.electronAPI.startCrawlerAuth(toIpcPayload({ ruleId, account_alias: accountAlias }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    await fetchSessions(ruleId)
    return res.data
  }

  async function fetchSessions(ruleId?: string) {
    const res = await window.electronAPI.listCrawlerSessions(toIpcPayload({ ruleId }))
    if (res.success) sessions.value = res.data as CrawlerSession[]
  }

  async function validateSession(ruleId: string, accountAlias: string) {
    const res = await window.electronAPI.validateCrawlerSession(toIpcPayload({ ruleId, account_alias: accountAlias }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    await fetchSessions(ruleId)
    return res.data as CrawlerSessionValidationResult
  }

  async function deleteSession(ruleId: string, accountAlias: string) {
    const res = await window.electronAPI.deleteCrawlerSession(toIpcPayload({ ruleId, account_alias: accountAlias }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    sessions.value = sessions.value.filter((session) => !(session.site_id === ruleId && session.account_alias === accountAlias))
  }

  async function fetchReviewItems(filter: { status?: string; ruleId?: string; runId?: string; limit?: number } = { status: 'pending' }) {
    const res = await window.electronAPI.listCrawlerReviewItems(toIpcPayload(filter))
    if (res.success) reviewItems.value = res.data as CrawlerReviewItem[]
  }

  async function rejectReviewItems(ids: string[], notes?: string) {
    const res = await window.electronAPI.rejectCrawlerReviewItems(toIpcPayload({ ids, notes }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    reviewItems.value = reviewItems.value.filter((item) => !ids.includes(item.id))
  }

  async function importReviewItems(args: { ids: string[]; target_group_id?: string | null; new_group?: NewCrawlerTargetGroup | null }) {
    const res = await window.electronAPI.importCrawlerReviewItems(toIpcPayload(args))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    reviewItems.value = reviewItems.value.filter((item) => !args.ids.includes(item.id))
    return res.data
  }

  async function inspectLoad(rule: Partial<CrawlerRule>, url?: string | null, accountAlias?: string | null) {
    const res = await window.electronAPI.inspectCrawlerLoad(toIpcPayload({
      rule,
      url,
      account_alias: accountAlias,
    }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return res.data as CrawlerInspectLoadResult
  }

  async function suggestSelector(args: {
    html: string
    path?: string | null
    selector?: string | null
    scope_selector?: string | null
  }) {
    const res = await window.electronAPI.suggestCrawlerSelector(toIpcPayload(args))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return (res.data as { candidates: CrawlerSelectorCandidate[] }).candidates
  }

  async function inspectPreview(args: {
    rule: Partial<CrawlerRule>
    html?: string | null
    url?: string | null
    account_alias?: string | null
  }) {
    const res = await window.electronAPI.inspectCrawlerPreview(toIpcPayload(args))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return res.data as CrawlerInspectPreviewResult
  }

  return {
    rules,
    loading,
    runs,
    reviewItems,
    sessions,
    activeRuleId,
    fetchRules,
    upsert,
    remove,
    testCrawl,
    run,
    fetchRuns,
    startAuth,
    fetchSessions,
    validateSession,
    deleteSession,
    fetchReviewItems,
    rejectReviewItems,
    importReviewItems,
    inspectLoad,
    suggestSelector,
    inspectPreview,
  }
})
