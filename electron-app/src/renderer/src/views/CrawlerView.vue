<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  useCrawlerStore,
  type CrawlerInspectLoadResult,
  type CrawlerInspectNode,
  type CrawlerInspectPreviewResult,
  type CrawlerReviewItem,
  type CrawlerRule,
  type CrawlerRuntimeStatus,
  type CrawlerSelectorCandidate,
  type CrawlerSessionValidationResult,
  type NewCrawlerTargetGroup,
} from '../stores/crawler'
import { useQuestionStore } from '../stores/question'

const store = useCrawlerStore()
const questionStore = useQuestionStore()

const showEdit = ref(false)
const editTarget = ref<Partial<CrawlerRule>>({})
const ruleJsonText = ref('{}')
const saving = ref(false)
const selectedRuleId = ref<string | null>(null)

const activeRun = ref<{ taskId: string; runId: string; ruleId: string } | null>(null)
const runProgress = ref(0)
const runMessage = ref('')
const runError = ref('')
const runStageFilter = ref<'all' | string>('all')

const testing = ref(false)
const testUrl = ref('')
const testResult = ref<{ count: number; samples: unknown[] } | null>(null)
const testError = ref('')

type SelectorTarget = 'item' | 'content' | 'options' | 'answer' | 'explanation' | 'detail_link'
type QuestionTypeConfig = '' | 'single' | 'multiple' | 'case' | 'essay'

const inspectUrl = ref('')
const inspectLoading = ref(false)
const inspectError = ref('')
const inspectSnapshot = ref<CrawlerInspectLoadResult | null>(null)
const selectedInspectNode = ref<CrawlerInspectNode | null>(null)
const selectorCandidates = ref<CrawlerSelectorCandidate[]>([])
const selectorTarget = ref<SelectorTarget>('item')
const selectorBusy = ref(false)
const previewBusy = ref(false)
const inspectPreviewResult = ref<CrawlerInspectPreviewResult | null>(null)
const questionTypeConfig = ref<QuestionTypeConfig>('')

const groupMode = ref<'existing' | 'new'>('existing')
const targetGroupId = ref('')
const newGroupName = ref('')
const newGroupType = ref<'crawled' | 'past_exam' | 'custom'>('crawled')
const importExamYear = ref<number | null>(null)
const importExamPeriod = ref<'H1' | 'H2' | ''>('')

// Run history group editing
const editingRunId = ref<string | null>(null)
const editRunGroupMode = ref<'existing' | 'new'>('existing')
const editRunTargetGroupId = ref('')
const editRunNewName = ref('')
const editRunNewType = ref<'crawled' | 'past_exam' | 'custom'>('crawled')
const editRunExamYear = ref<number | null>(null)
const editRunExamPeriod = ref<'H1' | 'H2' | ''>('')
const editRunSaving = ref(false)

const selectedReviewIds = ref<string[]>([])
const reviewSelectionMode = ref(false)
const reviewMessage = ref('')
const reviewError = ref('')
const accountAlias = ref('default')
const sessionMessage = ref('')
const sessionBusy = ref(false)
const sessionValidation = ref<CrawlerSessionValidationResult | null>(null)
const runtimeStatus = ref<CrawlerRuntimeStatus | null>(null)
const runtimeMessage = ref('')
const runtimeChecking = ref(false)

const selectedRule = computed(() => store.rules.find((r) => r.id === selectedRuleId.value) ?? null)
const selectedSessions = computed(() => {
  const ruleId = selectedRule.value?.id
  return ruleId ? store.sessions.filter((item) => item.site_id === ruleId) : []
})
const pendingCount = computed(() => store.reviewItems.length)
const existingImportGroups = computed(() => questionStore.groups)
const selectedReviewCount = computed(() => selectedReviewIds.value.length)
const allReviewsSelected = computed(() =>
  Boolean(store.reviewItems.length) && selectedReviewIds.value.length === store.reviewItems.length
)
const filteredRuns = computed(() => {
  if (runStageFilter.value === 'all') return store.runs
  return store.runs.filter((run) => (run.error_stage || run.status) === runStageFilter.value)
})
const runStageOptions = computed(() => {
  const values = new Set<string>()
  for (const run of store.runs) {
    if (run.error_stage) values.add(run.error_stage)
    else if (run.status) values.add(run.status)
  }
  return Array.from(values)
})
const importGroupReady = computed(() => {
  if (groupMode.value === 'existing') return Boolean(targetGroupId.value)
  if (!newGroupName.value.trim()) return false
  return true
})

watch(() => store.reviewItems.map((item) => item.id), (ids) => {
  selectedReviewIds.value = selectedReviewIds.value.filter((id) => ids.includes(id))
  if (!selectedReviewIds.value.length) reviewSelectionMode.value = false
})

onMounted(async () => {
  await Promise.all([
    store.fetchRules(),
    store.fetchReviewItems({ status: 'pending', limit: 100 }),
    store.fetchSessions(),
    questionStore.fetchGroups(),
  ])
  checkRuntimeStatus()
  window.electronAPI.onTaskProgress((msg) => {
    if (activeRun.value && msg.taskId === activeRun.value.taskId) {
      runProgress.value = msg.progress
      runMessage.value = msg.message
    }
  })
})

async function checkRuntimeStatus() {
  if (runtimeChecking.value) return
  runtimeChecking.value = true
  runtimeMessage.value = '正在检查 Chromium...'
  try {
    const status = await store.getRuntimeStatus()
    runtimeStatus.value = status
    runtimeMessage.value = status.message || (status.chromium_ready ? 'Chromium 可用' : 'Chromium 未就绪')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    runtimeMessage.value = message ? `检查 Chromium 失败：${message}` : '检查 Chromium 失败'
  } finally {
    runtimeChecking.value = false
  }
}

function defaultRule(): Partial<CrawlerRule> {
  return {
    site_name: '',
    adapter: 'http_rule',
    auth_required: 0,
    auth_mode: 'none',
    login_url: '',
    validate_url: '',
    url_template: 'https://example.com/questions?page={page}',
    item_selector: '.question-item',
    question_field: '.question-content',
    options_field: '.option',
    answer_field: '.answer',
    expl_field: '.explanation',
    rule_json: '{}',
    version: 1,
    max_pages: 5,
    delay_ms: 1500,
    is_enabled: 1,
  }
}

function openNew() {
  editTarget.value = defaultRule()
  questionTypeConfig.value = ''
  ruleJsonText.value = buildRuleJson(editTarget.value)
  testUrl.value = String(editTarget.value.url_template ?? '').replace('{page}', '1')
  resetInspector()
  testResult.value = null
  testError.value = ''
  showEdit.value = true
}

function openEdit(rule: CrawlerRule) {
  editTarget.value = { ...rule }
  questionTypeConfig.value = ''
  ruleJsonText.value = rule.rule_json && rule.rule_json !== '{}'
    ? JSON.stringify(JSON.parse(rule.rule_json), null, 2)
    : buildRuleJson(rule)
  questionTypeConfig.value = extractQuestionTypeConfig(ruleJsonText.value)
  testUrl.value = rule.url_template.replace('{page}', '1')
  resetInspector()
  testResult.value = null
  testError.value = ''
  showEdit.value = true
}

function buildRuleJson(rule: Partial<CrawlerRule>) {
  if (rule.adapter === 'api_json') {
    return JSON.stringify({
      api: {
        url: rule.url_template,
        method: 'GET',
        items_path: 'items',
        fields: { title: 'title', content: 'content', answer: 'answer', explanation: 'explanation', source_url: 'url' },
      },
    }, null, 2)
  }
  if (rule.adapter === 'feed_import') {
    return JSON.stringify({ feed: { url: rule.url_template } }, null, 2)
  }
  return JSON.stringify({
    auth: {
      login_url: rule.login_url || '',
      success: {
        url_pattern: '',
        success_selector: '',
        success_text: [],
        failure_text: [],
        required_cookies: [],
        capture_delay_ms: 1000,
      },
      validate: {
        url: rule.validate_url || '',
        success_statuses: [200],
        success_text: [],
        failure_text: [],
        required_cookies: [],
        url_pattern: '',
      },
    },
    list: {
      url_template: rule.url_template,
      item_selector: rule.item_selector,
      ...(questionTypeConfig.value ? { question_type: questionTypeConfig.value } : {}),
      fields: {
        content: rule.question_field,
        options: rule.options_field,
        answer: rule.answer_field,
        explanation: rule.expl_field,
      },
    },
    pagination: { type: 'page_param', max_pages: rule.max_pages },
    browser: {
      wait_until: 'networkidle',
      wait_selector: rule.item_selector,
      timeout_ms: 30000,
    },
    request: { delay_ms: rule.delay_ms },
  }, null, 2)
}

function getRecordValue(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function extractLoginUrlFromRuleJson(cfg: Record<string, unknown>): string {
  const auth = getRecordValue(cfg, 'auth')
  const login = getRecordValue(auth, 'login')
  const success = getRecordValue(auth, 'success')
  for (const value of [auth.login_url, login.url, login.login_url, success.login_url]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function extractQuestionTypeConfig(text: string): QuestionTypeConfig {
  try {
    const cfg = JSON.parse(text || '{}') as Record<string, unknown>
    const list = getRecordValue(cfg, 'list')
    const value = list.question_type ?? cfg.question_type
    return isQuestionTypeConfig(value) ? value : ''
  } catch {
    return ''
  }
}

function isQuestionTypeConfig(value: unknown): value is Exclude<QuestionTypeConfig, ''> {
  return value === 'single' || value === 'multiple' || value === 'case' || value === 'essay'
}

function syncRuleJsonTemplate() {
  ruleJsonText.value = buildRuleJson(editTarget.value)
}

function resetInspector() {
  inspectUrl.value = testUrl.value || String(editTarget.value.url_template ?? '').replace('{page}', '1')
  inspectError.value = ''
  inspectSnapshot.value = null
  selectedInspectNode.value = null
  selectorCandidates.value = []
  inspectPreviewResult.value = null
}

function draftRule(): Partial<CrawlerRule> {
  return {
    ...editTarget.value,
    rule_json: ruleJsonText.value || '{}',
  }
}

function patchRuleJson(mutator: (cfg: Record<string, unknown>) => void) {
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(ruleJsonText.value || '{}') as Record<string, unknown>
  } catch {
    cfg = JSON.parse(buildRuleJson(editTarget.value)) as Record<string, unknown>
  }
  mutator(cfg)
  ruleJsonText.value = JSON.stringify(cfg, null, 2)
}

function syncQuestionTypeConfig() {
  patchRuleJson((cfg) => {
    const list = (cfg.list && typeof cfg.list === 'object' ? cfg.list : {}) as Record<string, unknown>
    if (questionTypeConfig.value) list.question_type = questionTypeConfig.value
    else delete list.question_type
    cfg.list = list
  })
}

function setNestedSelector(target: SelectorTarget, selector: string) {
  if (target === 'item') editTarget.value.item_selector = selector
  if (target === 'content') editTarget.value.question_field = selector
  if (target === 'options') editTarget.value.options_field = selector
  if (target === 'answer') editTarget.value.answer_field = selector
  if (target === 'explanation') editTarget.value.expl_field = selector

  patchRuleJson((cfg) => {
    const list = (cfg.list && typeof cfg.list === 'object' ? cfg.list : {}) as Record<string, unknown>
    const fields = (list.fields && typeof list.fields === 'object' ? list.fields : {}) as Record<string, unknown>
    if (target === 'item') list.item_selector = selector
    else if (target === 'detail_link') list.detail_link_selector = selector
    else fields[target] = selector
    list.fields = fields
    list.url_template = editTarget.value.url_template ?? inspectUrl.value
    cfg.list = list
  })
}

async function loadInspectorPage() {
  inspectLoading.value = true
  inspectError.value = ''
  selectorCandidates.value = []
  selectedInspectNode.value = null
  inspectPreviewResult.value = null
  try {
    inspectSnapshot.value = await store.inspectLoad(
      draftRule(),
      inspectUrl.value || testUrl.value || null,
      accountAlias.value || null,
    )
    inspectUrl.value = inspectSnapshot.value.url
  } catch (e) {
    inspectError.value = String(e)
  } finally {
    inspectLoading.value = false
  }
}

async function pickInspectNode(node: CrawlerInspectNode) {
  if (!inspectSnapshot.value) return
  selectedInspectNode.value = node
  selectorBusy.value = true
  inspectError.value = ''
  try {
    selectorCandidates.value = await store.suggestSelector({
      html: inspectSnapshot.value.html,
      path: node.path,
      selector: node.selector,
      scope_selector: selectorTarget.value === 'item' ? null : editTarget.value.item_selector || null,
    })
  } catch (e) {
    inspectError.value = String(e)
  } finally {
    selectorBusy.value = false
  }
}

async function previewInspector() {
  previewBusy.value = true
  inspectError.value = ''
  inspectPreviewResult.value = null
  try {
    inspectPreviewResult.value = await store.inspectPreview({
      rule: draftRule(),
      html: inspectSnapshot.value?.html ?? null,
      url: inspectSnapshot.value?.url ?? inspectUrl.value,
      account_alias: accountAlias.value || null,
    })
  } catch (e) {
    inspectError.value = String(e)
  } finally {
    previewBusy.value = false
  }
}

async function save() {
  if (!editTarget.value.site_name?.trim()) return
  saving.value = true
  try {
    const parsedRuleJson = JSON.parse(ruleJsonText.value || '{}') as Record<string, unknown>
    const authRequired = editTarget.value.auth_required ? 1 : 0
    const loginUrl = String(editTarget.value.login_url || '').trim() || extractLoginUrlFromRuleJson(parsedRuleJson)
    const saved = await store.upsert({
      ...editTarget.value,
      auth_required: authRequired,
      auth_mode: authRequired ? 'manual_session' : 'none',
      login_url: loginUrl,
      rule_json: ruleJsonText.value || '{}',
    })
    selectedRuleId.value = saved.id
    showEdit.value = false
  } finally {
    saving.value = false
  }
}

async function doTest() {
  testing.value = true
  testResult.value = null
  testError.value = ''
  try {
    testResult.value = await store.testCrawl(
      { ...editTarget.value, rule_json: ruleJsonText.value },
      testUrl.value,
      accountAlias.value || null,
    ) as {
      count: number
      samples: unknown[]
    }
  } catch (e) {
    testError.value = String(e)
  } finally {
    testing.value = false
  }
}

function importGroupPayload(): { target_group_id?: string | null; new_group?: NewCrawlerTargetGroup | null; exam_year?: number | null; exam_period?: string | null } {
  const exam_year = importExamYear.value || null
  const exam_period = importExamPeriod.value || null
  if (groupMode.value === 'existing') return { target_group_id: targetGroupId.value || null, new_group: null, exam_year, exam_period }
  if (groupMode.value === 'new' && newGroupName.value.trim()) {
    return {
      target_group_id: null,
      new_group: {
        name: newGroupName.value.trim(),
        group_type: newGroupType.value,
      },
      exam_year,
      exam_period,
    }
  }
  return { target_group_id: null, new_group: null, exam_year, exam_period }
}

function groupOptionLabel(group: { name: string; group_type: string; exam_year?: number | null; exam_period?: string | null }) {
  return group.name
}

function runGroupLabel(run: typeof store.runs[number]): string {
  if (!run.target_group_id) return '未指定分组'
  const g = questionStore.groups.find((x) => x.id === run.target_group_id)
  if (!g) return '已删除的分组'
  if (run.exam_year) {
    return `${g.name} (${run.exam_year} ${run.exam_period === 'H1' ? '上' : '下'})`
  }
  return g.name
}

function startEditRun(run: typeof store.runs[number]) {
  editingRunId.value = run.id
  editRunGroupMode.value = 'existing'
  editRunTargetGroupId.value = run.target_group_id || ''
  editRunNewName.value = ''
  editRunNewType.value = 'crawled'
  editRunExamYear.value = run.exam_year ?? null
  editRunExamPeriod.value = (run.exam_period as 'H1' | 'H2' | '') || ''
}

function cancelEditRun() {
  editingRunId.value = null
}

async function saveEditRun(run: typeof store.runs[number]) {
  editRunSaving.value = true
  try {
    let groupId: string | null = null
    if (editRunGroupMode.value === 'existing') {
      groupId = editRunTargetGroupId.value || null
    } else if (editRunNewName.value.trim()) {
      const g = await questionStore.saveGroup({
        name: editRunNewName.value.trim(),
        group_type: editRunNewType.value,
        skipNameDedup: true,
      } as any)
      groupId = g.id
    }
    await store.updateRun(run.id, {
      target_group_id: groupId,
      exam_year: editRunExamYear.value || null,
      exam_period: editRunExamPeriod.value || null,
    })
    editingRunId.value = null
    if (run.rule_id) await store.fetchRuns(run.rule_id)
  } finally {
    editRunSaving.value = false
  }
}

async function runCrawl(ruleId: string) {
  runProgress.value = 0
  runMessage.value = '准备启动'
  runError.value = ''
  activeRun.value = null
  const result = await store.run({ ruleId, account_alias: accountAlias.value || null })
  activeRun.value = { ...result, ruleId }
  await store.fetchRuns(ruleId)
}

async function retryRun(ruleId: string) {
  await runCrawl(ruleId)
}

async function deleteRun(runId: string) {
  if (!window.confirm('删除这条运行历史？相关待确认结果也会一并删除。')) return
  reviewMessage.value = ''
  reviewError.value = ''
  try {
    await store.removeRun(runId)
    if (activeRun.value?.runId === runId) activeRun.value = null
    selectedReviewIds.value = []
    await store.fetchReviewItems({ status: 'pending', limit: 100 })
  } catch (e) {
    reviewError.value = e instanceof Error ? e.message : String(e)
  }
}

async function selectRule(ruleId: string) {
  selectedRuleId.value = ruleId
  await Promise.all([store.fetchRuns(ruleId), store.fetchSessions(ruleId)])
  const first = store.sessions.find((session) => session.site_id === ruleId)
  if (first) accountAlias.value = first.account_alias
}

function toggleReview(id: string, checked: boolean) {
  if (checked && !selectedReviewIds.value.includes(id)) selectedReviewIds.value.push(id)
  if (!checked) selectedReviewIds.value = selectedReviewIds.value.filter((x) => x !== id)
  // Auto-enter/exit selection mode based on whether any items are selected
  reviewSelectionMode.value = selectedReviewIds.value.length > 0
}

function toggleReviewSelection(id: string) {
  toggleReview(id, !selectedReviewIds.value.includes(id))
}

function toggleReviewSelectionMode() {
  reviewSelectionMode.value = !reviewSelectionMode.value
  if (!reviewSelectionMode.value) selectedReviewIds.value = []
}

function selectAllReviews() {
  reviewSelectionMode.value = true
  selectedReviewIds.value = store.reviewItems.map((item) => item.id)
}

function clearReviewSelection() {
  selectedReviewIds.value = []
}

async function importSelected() {
  if (!selectedReviewIds.value.length) return
  reviewMessage.value = ''
  reviewError.value = ''
  if (!importGroupReady.value) {
    reviewError.value = groupMode.value === 'existing'
      ? '请先选择入库分组'
      : '请填写新分组名称'
    return
  }
  try {
    const res = await store.importReviewItems({ ids: selectedReviewIds.value, ...importGroupPayload() })
    reviewMessage.value = `已入库 ${res.count} 条`
    selectedReviewIds.value = []
    await questionStore.fetchGroups()
    if (selectedRuleId.value) await store.fetchRuns(selectedRuleId.value)
  } catch (e) {
    reviewError.value = e instanceof Error ? e.message : String(e)
  }
}

async function rejectSelected() {
  if (!selectedReviewIds.value.length) return
  reviewMessage.value = ''
  reviewError.value = ''
  await store.rejectReviewItems(selectedReviewIds.value, 'Rejected by user')
  reviewMessage.value = `已丢弃 ${selectedReviewIds.value.length} 条`
  selectedReviewIds.value = []
}

async function startAuth() {
  if (!selectedRule.value) return
  sessionBusy.value = true
  sessionMessage.value = ''
  sessionValidation.value = null
  try {
    const saved = await store.startAuth(selectedRule.value.id, accountAlias.value || 'default')
    const mode = saved.storage_meta?.capture_mode === 'auto' ? '自动采集' : '手动采集'
    const url = typeof saved.storage_meta?.captured_url === 'string' ? saved.storage_meta.captured_url : ''
    sessionMessage.value = `授权已保存（${mode}${url ? `：${url}` : ''}）`
  } catch (e) {
    sessionMessage.value = String(e)
  } finally {
    sessionBusy.value = false
  }
}

async function openVisualConfig() {
  if (!selectedRule.value) return
  sessionBusy.value = true
  sessionMessage.value = ''
  sessionValidation.value = null
  try {
    await store.openVisualConfig(selectedRule.value.id, accountAlias.value || 'default')
    sessionMessage.value = '可视化采集配置已保存'
  } catch (e) {
    sessionMessage.value = String(e)
  } finally {
    sessionBusy.value = false
  }
}

async function validateSession() {
  if (!selectedRule.value) return
  sessionBusy.value = true
  sessionMessage.value = ''
  sessionValidation.value = null
  try {
    const res = await store.validateSession(selectedRule.value.id, accountAlias.value || 'default')
    sessionValidation.value = res
    sessionMessage.value = res.valid ? `会话有效${res.status ? ` (${res.status})` : ''}` : `会话无效${res.status ? ` (${res.status})` : ''}`
  } catch (e) {
    sessionMessage.value = String(e)
  } finally {
    sessionBusy.value = false
  }
}

async function deleteSession() {
  if (!selectedRule.value) return
  sessionBusy.value = true
  sessionMessage.value = ''
  sessionValidation.value = null
  try {
    await store.deleteSession(selectedRule.value.id, accountAlias.value || 'default')
    sessionMessage.value = '会话已清除'
  } catch (e) {
    sessionMessage.value = String(e)
  } finally {
    sessionBusy.value = false
  }
}

function statusClass(status: string) {
  if (status === 'completed') return 'ok'
  if (status === 'failed') return 'err'
  return 'warn'
}

function formatDate(iso?: string | null) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

type ReviewPayload = CrawlerReviewItem['normalized_payload']

const questionTypeLabels: Record<ReviewPayload['type'], string> = {
  single: '单选题',
  multiple: '多选题',
  case: '案例题',
  essay: '论文题',
}

function questionTypeLabel(type: ReviewPayload['type']) {
  return questionTypeLabels[type] ?? type
}

function reviewOptionsSummary(payload: ReviewPayload) {
  const options = payload.options?.filter((item) => item && item.trim()) ?? []
  if (!options.length) return ''
  return options.slice(0, 4).join('  ')
}
</script>

<template>
  <div class="crawler-view">
    <div class="view-header">
      <div>
        <h2>爬虫工作台</h2>
        <p>规则测试、运行任务、待确认入库</p>
      </div>
      <div class="header-actions">
        <button
          class="runtime-pill"
          :class="{ checking: runtimeChecking, ok: !runtimeChecking && runtimeStatus?.chromium_ready, warn: !runtimeChecking && runtimeStatus && !runtimeStatus.chromium_ready }"
          :disabled="runtimeChecking"
          @click="checkRuntimeStatus"
        >
          <span v-if="runtimeChecking">检查中...</span>
          <template v-else>
          {{ runtimeStatus?.chromium_ready ? 'Chromium ready' : '检查 Chromium' }}
          </template>
        </button>
        <button class="btn-primary" @click="openNew">新建规则</button>
      </div>
    </div>
    <p v-if="runtimeMessage || runtimeStatus?.message" class="runtime-message">{{ runtimeMessage || runtimeStatus?.message }}</p>

    <div class="workspace">
      <aside class="rule-list">
        <button
          v-for="rule in store.rules"
          :key="rule.id"
          class="rule-item"
          :class="{ active: selectedRuleId === rule.id }"
          @click="selectRule(rule.id)"
        >
          <span class="rule-title">{{ rule.site_name }}</span>
          <span class="rule-meta">{{ rule.adapter }} · 已抓取 {{ rule.total_crawled }}</span>
        </button>
        <div v-if="!store.loading && !store.rules.length" class="empty">暂无规则</div>
      </aside>

      <main class="panel">
        <div v-if="!selectedRule" class="empty fill">选择一个规则查看运行记录</div>
        <template v-else>
          <div class="panel-head rule-detail-head">
            <div class="rule-detail-title">
              <h3>{{ selectedRule.site_name }}</h3>
              <p>{{ selectedRule.url_template }}</p>
            </div>
            <div class="actions rule-actions">
              <button class="btn" @click="openEdit(selectedRule)">编辑</button>
              <button class="btn-primary" @click="runCrawl(selectedRule.id)">运行</button>
            </div>
          </div>

          <div v-if="activeRun?.ruleId === selectedRule.id" class="progress-box">
            <div class="progress-label">
              <span>{{ runMessage }}</span>
              <strong>{{ runProgress }}%</strong>
            </div>
            <div class="progress-track"><div class="progress-bar" :style="{ width: `${runProgress}%` }"></div></div>
            <p v-if="runError" class="error">{{ runError }}</p>
          </div>

          <section class="target-box review-destination">
            <label>抓取结果</label>
            <strong>待确认结果</strong>
            <span>运行后先进入待确认区，确认入库时再选择题库分组。</span>
          </section>

          <section v-if="selectedRule.auth_required" class="target-box">
            <label>登录态</label>
            <div class="session-row">
              <input v-model="accountAlias" class="input" placeholder="账号别名" />
              <button class="btn" :disabled="sessionBusy" @click="startAuth">登录并授权</button>
              <button class="btn" :disabled="sessionBusy" @click="openVisualConfig">可视化配置</button>
              <button class="btn" :disabled="sessionBusy" @click="validateSession">检查会话</button>
              <button class="btn" :disabled="sessionBusy" @click="deleteSession">清除会话</button>
            </div>
            <div class="sessions">
              <button
                v-for="session in selectedSessions"
                :key="session.id"
                class="session-pill"
                :class="{ active: accountAlias === session.account_alias }"
                @click="accountAlias = session.account_alias"
              >
                {{ session.account_alias }} · {{ formatDate(session.updated_at) }}
              </button>
            </div>
            <p v-if="sessionMessage" class="session-message">{{ sessionMessage }}</p>
            <div v-if="sessionValidation?.checks?.length" class="validation-list">
              <div
                v-for="check in sessionValidation.checks"
                :key="check.name"
                class="validation-row"
                :class="{ ok: check.valid, err: !check.valid }"
              >
                <span>{{ check.valid ? '通过' : '失败' }}</span>
                <strong>{{ check.name }}</strong>
                <small>{{ check.message }}</small>
              </div>
            </div>
          </section>

          <section>
            <div class="section-headline">
              <div class="section-title">运行历史</div>
              <select v-model="runStageFilter" class="input stage-filter">
                <option value="all">全部阶段</option>
                <option v-for="stage in runStageOptions" :key="stage" :value="stage">{{ stage }}</option>
              </select>
            </div>
            <div v-if="!store.runs.length" class="empty">暂无运行记录</div>
            <div v-else class="runs">
              <div v-for="run in filteredRuns" :key="run.id" class="run-row" :class="{ editing: editingRunId === run.id }">
                <template v-if="editingRunId === run.id">
                  <div class="run-edit-form">
                    <div class="segmented" style="margin-bottom:6px">
                      <button :class="{ active: editRunGroupMode === 'existing' }" @click="editRunGroupMode = 'existing'">现有分组</button>
                      <button :class="{ active: editRunGroupMode === 'new' }" @click="editRunGroupMode = 'new'">新建分组</button>
                    </div>
                    <select v-if="editRunGroupMode === 'existing'" v-model="editRunTargetGroupId" class="input" style="width:100%">
                      <option value="">未指定分组</option>
                      <option v-for="g in questionStore.groups" :key="g.id" :value="g.id">{{ groupOptionLabel(g) }}</option>
                    </select>
                    <template v-if="editRunGroupMode === 'new'">
                      <input v-model="editRunNewName" class="input" placeholder="分组名称" style="width:100%;margin-bottom:4px" />
                      <select v-model="editRunNewType" class="input" style="width:100%">
                        <option value="crawled">爬虫导入</option>
                        <option value="past_exam">历年真题</option>
                        <option value="custom">自定义</option>
                      </select>
                    </template>
                    <div class="exam-row" style="display:flex;gap:6px;margin-top:4px;align-items:center">
                      <span style="font-size:11px;color:var(--c-text-2);white-space:nowrap">真题年份 · 期次（可选）</span>
                      <input v-model.number="editRunExamYear" class="input" type="number" placeholder="年份" style="width:80px" min="2000" max="2100" />
                      <select v-model="editRunExamPeriod" class="input" style="width:90px">
                        <option value="">不限</option>
                        <option value="H1">上半年</option>
                        <option value="H2">下半年</option>
                      </select>
                    </div>
                    <div style="display:flex;gap:4px;margin-top:6px">
                      <button class="btn mini-btn primary" :disabled="editRunSaving" @click="saveEditRun(run)">{{ editRunSaving ? '保存中…' : '保存' }}</button>
                      <button class="btn mini-btn" @click="cancelEditRun">取消</button>
                    </div>
                  </div>
                </template>
                <template v-else>
                  <span class="badge" :class="statusClass(run.status)">{{ run.status }}</span>
                  <span>抓取 {{ run.total_found }}</span>
                  <span>已入库 {{ run.total_saved }}</span>
                  <span class="run-group-label">{{ runGroupLabel(run) }}</span>
                  <span>{{ formatDate(run.started_at) }}</span>
                  <small v-if="run.error_msg">{{ run.error_stage || 'unknown' }} · {{ run.error_code || 'CRAWLER_ERROR' }} · {{ run.error_msg }}</small>
                  <div class="run-actions">
                    <button class="btn mini-btn" title="修改分组" @click="startEditRun(run)">✎</button>
                    <button v-if="run.status === 'failed'" class="btn mini-btn" @click="retryRun(selectedRule.id)">重试</button>
                    <button class="btn mini-btn danger" :disabled="run.status === 'running'" @click="deleteRun(run.id)">删除</button>
                  </div>
                </template>
              </div>
              <div v-if="store.runs.length && !filteredRuns.length" class="empty">当前阶段没有运行记录</div>
            </div>
          </section>
        </template>
      </main>
    </div>

    <section class="review-panel">
      <div class="panel-head compact">
        <div>
          <h3>待确认结果</h3>
          <p>{{ pendingCount }} 条待处理，确认后才写入题库</p>
        </div>
        <div class="actions">
          <button class="btn" @click="store.fetchReviewItems({ status: 'pending', limit: 100 })">刷新</button>
          <button
            class="btn"
            :class="{ active: reviewSelectionMode }"
            :disabled="!store.reviewItems.length"
            @click="toggleReviewSelectionMode"
          >
            {{ reviewSelectionMode ? '退出多选' : '多选' }}
          </button>
          <button class="btn" :disabled="!selectedReviewCount" @click="rejectSelected">丢弃</button>
          <button class="btn-primary" :disabled="!selectedReviewCount || !importGroupReady" @click="importSelected">确认入库</button>
        </div>
      </div>
      <section class="target-box review-import-target">
        <label>确认入库分组</label>
        <div class="segmented">
          <button :class="{ active: groupMode === 'existing' }" @click="groupMode = 'existing'">现有分组</button>
          <button :class="{ active: groupMode === 'new' }" @click="groupMode = 'new'">新建分组</button>
        </div>
        <div v-if="groupMode === 'existing'" class="existing-group-grid">
          <select v-model="targetGroupId" class="input">
            <option value="">选择分组</option>
            <option v-for="g in existingImportGroups" :key="g.id" :value="g.id">{{ groupOptionLabel(g) }}</option>
          </select>
        </div>
        <div v-if="groupMode === 'new'" class="group-grid">
          <input v-model="newGroupName" class="input" placeholder="分组名称" />
          <select v-model="newGroupType" class="input">
            <option value="crawled">爬虫导入</option>
            <option value="past_exam">历年真题</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div class="exam-row" style="display:flex;gap:6px;margin-top:6px;align-items:center">
          <span style="font-size:11px;color:var(--c-text-2);white-space:nowrap">真题年份 · 期次（可选）</span>
          <input v-model.number="importExamYear" class="input" type="number" placeholder="年份" style="width:80px" min="2000" max="2100" />
          <select v-model="importExamPeriod" class="input" style="width:90px">
            <option value="">不限</option>
            <option value="H1">上半年</option>
            <option value="H2">下半年</option>
          </select>
        </div>
      </section>
      <p v-if="reviewMessage" class="success">{{ reviewMessage }}</p>
      <p v-if="reviewError" class="error">{{ reviewError }}</p>
      <div v-if="!store.reviewItems.length" class="empty">暂无待确认结果</div>
      <div v-else class="review-list">
        <div v-if="reviewSelectionMode || selectedReviewCount" class="review-selection-bar">
          <span>已选 {{ selectedReviewCount }} / {{ pendingCount }}</span>
          <div class="actions">
            <button class="btn mini-btn" :disabled="allReviewsSelected" @click="selectAllReviews">全选</button>
            <button class="btn mini-btn" :disabled="!selectedReviewCount" @click="clearReviewSelection">清空</button>
          </div>
        </div>
        <div
          v-for="item in store.reviewItems"
          :key="item.id"
          class="review-item"
          :class="{ selected: selectedReviewIds.includes(item.id), selectable: reviewSelectionMode || selectedReviewCount > 0 }"
          role="checkbox"
          tabindex="0"
          :aria-checked="selectedReviewIds.includes(item.id)"
          @click="toggleReviewSelection(item.id)"
          @keydown.enter.prevent="toggleReviewSelection(item.id)"
          @keydown.space.prevent="toggleReviewSelection(item.id)"
        >
          <input
            v-if="reviewSelectionMode || selectedReviewIds.includes(item.id)"
            type="checkbox"
            :checked="selectedReviewIds.includes(item.id)"
            @click.stop
            @change="toggleReview(item.id, ($event.target as HTMLInputElement).checked)"
          />
          <div>
            <div class="review-title-row">
              <span class="type-pill">{{ questionTypeLabel(item.normalized_payload.type) }}</span>
              <strong>{{ item.normalized_payload.title || item.normalized_payload.content.slice(0, 42) }}</strong>
            </div>
            <p v-html="item.normalized_payload.content"></p>
            <p v-if="reviewOptionsSummary(item.normalized_payload)" class="review-extra">
              <span v-for="(opt, i) in (item.normalized_payload.options || [])" :key="i">
                <span v-html="opt"></span><br v-if="i < (item.normalized_payload.options || []).length - 1" />
              </span>
            </p>
            <p v-if="item.normalized_payload.answer" class="review-extra">
              答案：{{ item.normalized_payload.answer }}
            </p>
            <small>{{ item.normalized_payload.source_url || 'no url' }}</small>
          </div>
        </div>
      </div>
    </section>

    <div v-if="showEdit" class="modal-backdrop">
      <div class="modal">
        <header class="modal-head">
          <h3>{{ editTarget.id ? '编辑规则' : '新建规则' }}</h3>
          <button class="icon-button" @click="showEdit = false">×</button>
        </header>
        <div class="modal-body">
          <div class="form-grid">
            <label>站点名称<input v-model="editTarget.site_name" class="input" /></label>
            <label>适配器
              <select v-model="editTarget.adapter" class="input" @change="syncRuleJsonTemplate">
                <option value="http_rule">静态页面</option>
                <option value="browser_rule">动态页面</option>
                <option value="api_json">JSON API</option>
                <option value="feed_import">RSS/Atom</option>
                <option value="manual_clip">手动剪藏</option>
              </select>
            </label>
            <label class="wide">URL 模板<input v-model="editTarget.url_template" class="input" @blur="syncRuleJsonTemplate" /></label>
            <label>最大页数<input v-model.number="editTarget.max_pages" class="input" type="number" min="1" /></label>
            <label>延迟 ms<input v-model.number="editTarget.delay_ms" class="input" type="number" min="0" /></label>
            <label>条目选择器<input v-model="editTarget.item_selector" class="input" /></label>
            <label>
              题型配置
              <select v-model="questionTypeConfig" class="input" @change="syncQuestionTypeConfig">
                <option value="">自动判断</option>
                <option value="single">单选题</option>
                <option value="multiple">多选题</option>
                <option value="case">案例题</option>
                <option value="essay">论文题</option>
              </select>
            </label>
            <label>题干选择器<input v-model="editTarget.question_field" class="input" /></label>
            <label>选项选择器<input v-model="editTarget.options_field" class="input" /></label>
            <label>答案选择器<input v-model="editTarget.answer_field" class="input" /></label>
            <label>解析选择器<input v-model="editTarget.expl_field" class="input" /></label>
            <label class="checkline"><input v-model="editTarget.auth_required" type="checkbox" :true-value="1" :false-value="0" /> 需要登录态</label>
            <label>登录 URL<input v-model="editTarget.login_url" class="input" /></label>
            <label>校验 URL<input v-model="editTarget.validate_url" class="input" /></label>
            <section v-if="editTarget.adapter === 'http_rule' || editTarget.adapter === 'browser_rule'" class="wide inspector-box">
              <div class="inspector-head">
                <div>
                  <strong>可视化规则配置</strong>
                  <span>加载页面快照，选择节点后写回 Selector</span>
                </div>
                <button class="btn" :disabled="inspectLoading" @click="loadInspectorPage">
                  {{ inspectLoading ? '加载中' : '加载页面' }}
                </button>
              </div>
              <div class="inspect-toolbar">
                <input v-model="inspectUrl" class="input" placeholder="预览 URL" />
                <select v-model="selectorTarget" class="input selector-target">
                  <option value="item">题目容器</option>
                  <option value="content">题干字段</option>
                  <option value="options">选项字段</option>
                  <option value="answer">答案字段</option>
                  <option value="explanation">解析字段</option>
                  <option value="detail_link">详情链接</option>
                </select>
                <button class="btn" :disabled="previewBusy" @click="previewInspector">
                  {{ previewBusy ? '预览中' : '预览匹配' }}
                </button>
              </div>
              <p v-if="inspectError" class="error">{{ inspectError }}</p>
              <div v-if="inspectSnapshot" class="inspector-grid">
                <div class="node-list">
                  <button
                    v-for="node in inspectSnapshot.nodes"
                    :key="node.path"
                    class="node-row"
                    :class="{ active: selectedInspectNode?.path === node.path }"
                    @click="pickInspectNode(node)"
                  >
                    <span>{{ node.tag }} · {{ node.selector }}</span>
                    <small>{{ node.text || node.classes.join('.') || node.id || node.path }}</small>
                  </button>
                </div>
                <div class="candidate-panel">
                  <div class="candidate-title">
                    <strong>Selector 候选</strong>
                    <span v-if="selectorBusy">生成中</span>
                  </div>
                  <div v-if="!selectorCandidates.length" class="empty small-empty">选择左侧节点</div>
                  <button
                    v-for="candidate in selectorCandidates"
                    :key="candidate.selector"
                    class="candidate-row"
                    :disabled="candidate.kind === 'xpath'"
                    @click="candidate.kind === 'xpath' ? null : setNestedSelector(selectorTarget, candidate.selector)"
                  >
                    <code>{{ candidate.selector }}</code>
                    <span>{{ candidate.match_count }} 个匹配 · {{ candidate.stability }}</span>
                  </button>
                  <div v-if="inspectPreviewResult" class="preview-summary">
                    <strong>匹配 {{ inspectPreviewResult.count }} 个容器</strong>
                    <pre>{{ JSON.stringify(inspectPreviewResult.selector_matches, null, 2) }}</pre>
                    <pre v-if="inspectPreviewResult.samples.length">{{ JSON.stringify(inspectPreviewResult.samples[0], null, 2) }}</pre>
                  </div>
                </div>
              </div>
            </section>
            <label class="wide">规则 JSON<textarea v-model="ruleJsonText" class="input code-area"></textarea></label>
          </div>

          <div class="test-box">
            <input v-model="testUrl" class="input" placeholder="测试 URL" />
            <button class="btn" :disabled="testing" @click="doTest">{{ testing ? '测试中' : '测试抓取' }}</button>
          </div>
          <p v-if="testError" class="error">{{ testError }}</p>
          <div v-if="testResult" class="sample-box">
            <strong>找到 {{ testResult.count }} 条</strong>
            <pre>{{ JSON.stringify(testResult.samples, null, 2) }}</pre>
          </div>
        </div>
        <footer class="modal-foot">
          <button class="btn" @click="showEdit = false">取消</button>
          <button class="btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中' : '保存' }}</button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crawler-view { display: flex; flex-direction: column; gap: 14px; height: 100%; overflow: hidden; }
.view-header, .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.view-header h2, .panel-head h3 { font-size: 20px; font-weight: 700; color: var(--c-text); }
.view-header p, .panel-head p { font-size: 12px; color: var(--c-text-2); margin-top: 2px; }
.header-actions { display: flex; align-items: center; gap: 8px; }
.runtime-pill { border: 1px solid var(--c-border); border-radius: 999px; height: 30px; padding: 0 11px; background: var(--c-panel); color: var(--c-text-2); cursor: pointer; font-size: 12px; }
.runtime-pill:disabled { opacity: .72; cursor: wait; }
.runtime-pill.checking { border-color: #1d4ed8; color: #1d4ed8; background: #dbeafe; }
.runtime-pill.ok { border-color: var(--c-ok-text); color: var(--c-ok-text); background: var(--c-ok-bg); }
.runtime-pill.warn { border-color: var(--c-warn-text); color: var(--c-warn-text); background: var(--c-warn-bg); }
.runtime-message { margin-top: -8px; color: var(--c-text-2); font-size: 12px; }
.workspace { min-height: 0; flex: 1; display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 12px; }
.rule-list, .panel, .review-panel { border: 1px solid var(--c-border); background: var(--c-panel); border-radius: 8px; }
.rule-list { padding: 8px; overflow: auto; }
.rule-item { width: 100%; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 10px; cursor: pointer; color: var(--c-text); }
.rule-item:hover, .rule-item.active { background: var(--c-hover); border-color: var(--c-border); }
.rule-title { display: block; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-meta { display: block; margin-top: 2px; color: var(--c-text-2); font-size: 12px; }
.panel { padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
.rule-detail-head { align-items: flex-start; min-width: 0; }
.rule-detail-title { min-width: 0; flex: 1 1 auto; overflow: hidden; }
.rule-detail-title h3 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-detail-title p { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-actions { flex: 0 0 auto; flex-wrap: nowrap; justify-content: flex-end; }
.compact h3 { font-size: 16px; }
.actions { display: flex; gap: 8px; align-items: center; }
.btn, .btn-primary { border: 1px solid var(--c-border); border-radius: 6px; height: 32px; padding: 0 12px; cursor: pointer; color: var(--c-text); background: var(--c-panel); }
.btn:hover:not(:disabled) { background: var(--c-hover); }
.btn.active { border-color: #1d4ed8; background: #dbeafe; color: #1d4ed8; font-weight: 700; }
.btn-primary { border-color: #1d4ed8; background: #1d4ed8; color: white; font-weight: 700; }
.btn:disabled, .btn-primary:disabled { opacity: .45; cursor: not-allowed; }
.progress-box, .target-box { border: 1px solid var(--c-border); background: var(--c-bg); border-radius: 8px; padding: 12px; }
.progress-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--c-text-2); margin-bottom: 6px; }
.progress-track { height: 7px; background: var(--c-border); border-radius: 999px; overflow: hidden; }
.progress-bar { height: 100%; background: #2563eb; transition: width .2s; }
.target-box { display: flex; flex-direction: column; gap: 8px; }
.target-box > label, .section-title { font-size: 12px; color: var(--c-text-2); font-weight: 700; }
.review-destination strong { color: var(--c-text); font-size: 15px; }
.review-destination span { color: var(--c-text-2); font-size: 12px; }
.review-import-target { margin: 10px 0; }
.section-headline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.section-headline .section-title { white-space: nowrap; }
.stage-filter { flex: 0 0 108px; width: 108px; min-height: 30px; padding-block: 4px; font-size: 12px; }
.session-row { display: grid; grid-template-columns: minmax(140px, 1fr) repeat(4, max-content); gap: 8px; align-items: center; }
.session-row .btn { white-space: nowrap; }
.sessions { display: flex; flex-wrap: wrap; gap: 6px; }
.session-pill { border: 1px solid var(--c-border); background: var(--c-panel); color: var(--c-text-2); border-radius: 999px; padding: 4px 9px; font-size: 12px; cursor: pointer; }
.session-pill.active { border-color: #1d4ed8; color: #1d4ed8; background: #dbeafe; }
.session-message { color: var(--c-text-2); font-size: 12px; }
.validation-list { display: flex; flex-direction: column; gap: 6px; }
.validation-row { display: grid; grid-template-columns: 42px 150px minmax(0, 1fr); gap: 8px; align-items: center; border: 1px solid var(--c-border); border-radius: 6px; padding: 7px 9px; font-size: 12px; }
.validation-row span { font-weight: 700; }
.validation-row.ok span { color: var(--c-ok-text); }
.validation-row.err span { color: #dc2626; }
.validation-row strong { color: var(--c-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.validation-row small { color: var(--c-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.segmented { display: inline-flex; border: 1px solid var(--c-border); border-radius: 6px; overflow: hidden; width: fit-content; }
.segmented button { border: 0; border-right: 1px solid var(--c-border); background: var(--c-panel); color: var(--c-text); height: 30px; padding: 0 10px; cursor: pointer; }
.segmented button:last-child { border-right: 0; }
.segmented button.active { background: #dbeafe; color: #1d4ed8; font-weight: 700; }
.group-grid, .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.existing-group-grid { display: grid; grid-template-columns: minmax(120px, 160px) minmax(110px, 140px) minmax(220px, 1fr); gap: 10px; }
.existing-group-grid .wide-select { min-width: 0; }
.input { width: 100%; border: 1px solid var(--c-input-border); background: var(--c-input); color: var(--c-text); border-radius: 6px; padding: 7px 9px; min-height: 34px; }
.runs, .review-list { display: flex; flex-direction: column; gap: 8px; }
.run-row { display: grid; grid-template-columns: 72px 72px 86px 130px 112px minmax(0, 1fr) auto; gap: 7px; align-items: center; padding: 9px; border: 1px solid var(--c-border); border-radius: 6px; font-size: 12px; }
.run-row.editing { grid-template-columns: 1fr; padding: 12px; }
.run-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-group-label { color: var(--c-brand); font-size: 11px; }
.run-edit-form { display: flex; flex-direction: column; gap: 4px; max-width: 400px; }
.run-actions { display: flex; justify-content: flex-end; gap: 6px; white-space: nowrap; }
.mini-btn { height: 26px; padding: 0 8px; font-size: 12px; }
.mini-btn.danger { color: #dc2626; border-color: #fecaca; }
.mini-btn.danger:hover:not(:disabled) { background: #fee2e2; }
.badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; width: fit-content; }
.badge.ok { background: var(--c-ok-bg); color: var(--c-ok-text); }
.badge.warn { background: var(--c-warn-bg); color: var(--c-warn-text); }
.badge.err { background: #fee2e2; color: #dc2626; }
.review-panel { max-height: 42%; min-height: 240px; padding: 14px; overflow: auto; }
.review-selection-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid var(--c-border); background: var(--c-bg); border-radius: 6px; padding: 8px 10px; font-size: 12px; color: var(--c-text-2); }
.review-item { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 10px; border: 1px solid var(--c-border); border-radius: 6px; cursor: default; }
.review-item.selectable { grid-template-columns: 20px minmax(0, 1fr); cursor: pointer; }
.review-item.selected { border-color: #1d4ed8; background: #dbeafe; }
.review-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.review-title-row strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.type-pill { flex: 0 0 auto; border: 1px solid #1d4ed8; background: #dbeafe; color: #1d4ed8; border-radius: 999px; padding: 1px 7px; font-size: 11px; font-weight: 700; }
.review-item strong { font-weight: 700; color: var(--c-text); }
.review-item p { color: var(--c-text-2); font-size: 12px; max-height: 38px; overflow: hidden; }
.review-item .review-extra { color: var(--c-text-3); max-height: 34px; }
.review-item small, .run-row small { color: var(--c-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--c-text-3); text-align: center; padding: 24px; }
.fill { margin: auto; }
.success { color: var(--c-ok-text); font-size: 12px; }
.error { color: #dc2626; font-size: 12px; }
.modal-backdrop { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(15,23,42,.62); z-index: 100; }
.modal { width: min(920px, calc(100vw - 40px)); max-height: min(860px, calc(100vh - 40px)); background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 8px; display: flex; flex-direction: column; }
.modal-head, .modal-foot { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--c-border); }
.modal-foot { border-top: 1px solid var(--c-border); border-bottom: 0; justify-content: flex-end; gap: 8px; }
.modal-head h3 { font-size: 16px; font-weight: 700; }
.icon-button { width: 30px; height: 30px; border: 0; background: transparent; font-size: 24px; color: var(--c-text-2); cursor: pointer; }
.modal-body { padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--c-text-2); font-weight: 700; }
.wide { grid-column: 1 / -1; }
.checkline { flex-direction: row !important; align-items: center; }
.code-area { min-height: 150px; font-family: Consolas, monospace; font-size: 12px; resize: vertical; }
.inspector-box { border: 1px solid var(--c-border); background: var(--c-bg); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.inspector-head div { display: flex; flex-direction: column; gap: 2px; }
.inspector-head strong, .candidate-title strong { color: var(--c-text); font-size: 13px; }
.inspector-head span, .candidate-title span { color: var(--c-text-2); font-size: 12px; font-weight: 500; }
.inspect-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 150px auto; gap: 8px; }
.selector-target { min-width: 0; }
.inspector-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(260px, .85fr); gap: 10px; min-height: 280px; }
.node-list, .candidate-panel { border: 1px solid var(--c-border); background: var(--c-panel); border-radius: 6px; overflow: auto; max-height: 360px; }
.node-list { padding: 6px; display: flex; flex-direction: column; gap: 5px; }
.node-row, .candidate-row { width: 100%; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--c-text); cursor: pointer; text-align: left; padding: 8px; }
.node-row:hover, .node-row.active, .candidate-row:hover { background: var(--c-hover); border-color: var(--c-border); }
.node-row span, .candidate-row code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.node-row small, .candidate-row span { display: block; margin-top: 3px; color: var(--c-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.candidate-panel { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.candidate-title { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 2px 2px 4px; }
.candidate-row code { color: #1d4ed8; font-family: Consolas, monospace; }
.small-empty { padding: 14px; }
.preview-summary { border-top: 1px solid var(--c-border); margin-top: 4px; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.preview-summary strong { color: var(--c-text); font-size: 12px; }
.preview-summary pre { margin: 0; max-height: 120px; overflow: auto; white-space: pre-wrap; color: var(--c-text-2); font-size: 11px; }
.test-box { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.sample-box { border: 1px solid var(--c-border); background: var(--c-bg); border-radius: 6px; padding: 10px; }
.sample-box pre { white-space: pre-wrap; max-height: 180px; overflow: auto; font-size: 12px; color: var(--c-text-2); }
@media (max-width: 900px) {
  .workspace { grid-template-columns: 1fr; }
  .rule-list { max-height: 180px; }
  .run-row { grid-template-columns: 1fr 1fr; }
  .session-row { grid-template-columns: 1fr 1fr; }
  .validation-row { grid-template-columns: 1fr; }
  .inspect-toolbar, .inspector-grid { grid-template-columns: 1fr; }
}
</style>
