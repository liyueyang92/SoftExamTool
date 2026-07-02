import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toIpcPayload } from '../utils/ipc'

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

export interface NewCrawlerTargetGroup {
  name: string
  group_type?: 'custom' | 'past_exam' | 'ai_generated' | 'crawled' | 'manual_import'
  exam_year?: number | null
  exam_period?: 'H1' | 'H2' | null
  description?: string
}

export const useCrawlerStore = defineStore('crawler', () => {
  const rules = ref<CrawlerRule[]>([])
  const loading = ref(false)
  const runs = ref<CrawlerRun[]>([])
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

  async function testCrawl(rule: Partial<CrawlerRule>, testUrl: string) {
    const res = await window.electronAPI.testCrawl(toIpcPayload({ rule, test_url: testUrl }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return res.data
  }

  async function run(args: { ruleId: string; target_group_id?: string | null; new_group?: NewCrawlerTargetGroup | null }) {
    const res = await window.electronAPI.runCrawl(toIpcPayload(args))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return res.data
  }

  async function fetchRuns(ruleId: string) {
    const res = await window.electronAPI.listCrawlerRuns(ruleId)
    if (res.success) runs.value = res.data as CrawlerRun[]
  }

  return { rules, loading, runs, activeRuleId, fetchRules, upsert, remove, testCrawl, run, fetchRuns }
})
