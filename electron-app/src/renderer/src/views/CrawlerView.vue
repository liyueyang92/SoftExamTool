<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  useCrawlerStore,
  type CrawlerInspectLoadResult,
  type CrawlerInspectNode,
  type CrawlerInspectPreviewResult,
  type CrawlerRule,
  type CrawlerSelectorCandidate,
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

const testing = ref(false)
const testUrl = ref('')
const testResult = ref<{ count: number; samples: unknown[] } | null>(null)
const testError = ref('')

type SelectorTarget = 'item' | 'content' | 'options' | 'answer' | 'explanation' | 'detail_link'

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

const groupMode = ref<'none' | 'existing' | 'new'>('none')
const targetGroupId = ref('')
const newGroupName = ref('')
const newGroupType = ref<'crawled' | 'past_exam' | 'custom'>('crawled')
const newGroupYear = ref<number | null>(null)
const newGroupPeriod = ref<'H1' | 'H2'>('H1')

const selectedReviewIds = ref<string[]>([])
const reviewMessage = ref('')
const accountAlias = ref('default')
const sessionMessage = ref('')
const sessionBusy = ref(false)

const selectedRule = computed(() => store.rules.find((r) => r.id === selectedRuleId.value) ?? null)
const selectedSessions = computed(() => {
  const ruleId = selectedRule.value?.id
  return ruleId ? store.sessions.filter((item) => item.site_id === ruleId) : []
})
const pendingCount = computed(() => store.reviewItems.length)

onMounted(async () => {
  await Promise.all([
    store.fetchRules(),
    store.fetchReviewItems({ status: 'pending', limit: 100 }),
    store.fetchSessions(),
    questionStore.fetchGroups(),
  ])
  window.electronAPI.onTaskProgress((msg) => {
    if (activeRun.value && msg.taskId === activeRun.value.taskId) {
      runProgress.value = msg.progress
      runMessage.value = msg.message
    }
  })
})

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
  ruleJsonText.value = buildRuleJson(editTarget.value)
  testUrl.value = String(editTarget.value.url_template ?? '').replace('{page}', '1')
  resetInspector()
  testResult.value = null
  testError.value = ''
  showEdit.value = true
}

function openEdit(rule: CrawlerRule) {
  editTarget.value = { ...rule }
  ruleJsonText.value = rule.rule_json && rule.rule_json !== '{}'
    ? JSON.stringify(JSON.parse(rule.rule_json), null, 2)
    : buildRuleJson(rule)
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
    list: {
      url_template: rule.url_template,
      item_selector: rule.item_selector,
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
    JSON.parse(ruleJsonText.value || '{}')
    const authRequired = editTarget.value.auth_required ? 1 : 0
    const saved = await store.upsert({
      ...editTarget.value,
      auth_required: authRequired,
      auth_mode: authRequired ? 'manual_session' : 'none',
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

function currentGroupPayload(): { target_group_id?: string | null; new_group?: NewCrawlerTargetGroup | null } {
  if (groupMode.value === 'existing') return { target_group_id: targetGroupId.value || null, new_group: null }
  if (groupMode.value === 'new' && newGroupName.value.trim()) {
    return {
      target_group_id: null,
      new_group: {
        name: newGroupName.value.trim(),
        group_type: newGroupType.value,
        exam_year: newGroupType.value === 'past_exam' ? newGroupYear.value : null,
        exam_period: newGroupType.value === 'past_exam' ? newGroupPeriod.value : null,
      },
    }
  }
  return { target_group_id: null, new_group: null }
}

async function runCrawl(ruleId: string) {
  runProgress.value = 0
  runMessage.value = '准备启动'
  runError.value = ''
  activeRun.value = null
  const result = await store.run({ ruleId, ...currentGroupPayload(), account_alias: accountAlias.value || null })
  activeRun.value = { ...result, ruleId }
  await store.fetchRuns(ruleId)
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
}

async function importSelected() {
  if (!selectedReviewIds.value.length) return
  const res = await store.importReviewItems({ ids: selectedReviewIds.value, ...currentGroupPayload() })
  reviewMessage.value = `已入库 ${res.count} 条`
  selectedReviewIds.value = []
  await questionStore.fetchGroups()
  if (selectedRuleId.value) await store.fetchRuns(selectedRuleId.value)
}

async function rejectSelected() {
  if (!selectedReviewIds.value.length) return
  await store.rejectReviewItems(selectedReviewIds.value, 'Rejected by user')
  reviewMessage.value = `已丢弃 ${selectedReviewIds.value.length} 条`
  selectedReviewIds.value = []
}

async function startAuth() {
  if (!selectedRule.value) return
  sessionBusy.value = true
  sessionMessage.value = ''
  try {
    await store.startAuth(selectedRule.value.id, accountAlias.value || 'default')
    sessionMessage.value = '授权已保存'
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
  try {
    const res = await store.validateSession(selectedRule.value.id, accountAlias.value || 'default')
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
</script>

<template>
  <div class="crawler-view">
    <div class="view-header">
      <div>
        <h2>爬虫工作台</h2>
        <p>规则测试、运行任务、待确认入库</p>
      </div>
      <button class="btn-primary" @click="openNew">新建规则</button>
    </div>

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
          <div class="panel-head">
            <div>
              <h3>{{ selectedRule.site_name }}</h3>
              <p>{{ selectedRule.url_template }}</p>
            </div>
            <div class="actions">
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

          <section class="target-box">
            <label>入库分组</label>
            <div class="segmented">
              <button :class="{ active: groupMode === 'none' }" @click="groupMode = 'none'">不指定</button>
              <button :class="{ active: groupMode === 'existing' }" @click="groupMode = 'existing'">现有分组</button>
              <button :class="{ active: groupMode === 'new' }" @click="groupMode = 'new'">新建分组</button>
            </div>
            <select v-if="groupMode === 'existing'" v-model="targetGroupId" class="input">
              <option value="">选择分组</option>
              <option v-for="g in questionStore.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
            <div v-if="groupMode === 'new'" class="group-grid">
              <input v-model="newGroupName" class="input" placeholder="分组名称" />
              <select v-model="newGroupType" class="input">
                <option value="crawled">爬虫导入</option>
                <option value="past_exam">历年真题</option>
                <option value="custom">自定义</option>
              </select>
              <input v-if="newGroupType === 'past_exam'" v-model.number="newGroupYear" class="input" type="number" placeholder="年份" />
              <select v-if="newGroupType === 'past_exam'" v-model="newGroupPeriod" class="input">
                <option value="H1">上半年</option>
                <option value="H2">下半年</option>
              </select>
            </div>
          </section>

          <section v-if="selectedRule.auth_required" class="target-box">
            <label>登录态</label>
            <div class="session-row">
              <input v-model="accountAlias" class="input" placeholder="账号别名" />
              <button class="btn" :disabled="sessionBusy" @click="startAuth">登录并授权</button>
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
          </section>

          <section>
            <div class="section-title">运行历史</div>
            <div v-if="!store.runs.length" class="empty">暂无运行记录</div>
            <div v-else class="runs">
              <div v-for="run in store.runs" :key="run.id" class="run-row">
                <span class="badge" :class="statusClass(run.status)">{{ run.status }}</span>
                <span>抓取 {{ run.total_found }}</span>
                <span>待确认/入库 {{ run.total_saved }}</span>
                <span>{{ formatDate(run.started_at) }}</span>
                <small v-if="run.error_msg">{{ run.error_msg }}</small>
              </div>
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
          <button class="btn" :disabled="!selectedReviewIds.length" @click="rejectSelected">丢弃</button>
          <button class="btn-primary" :disabled="!selectedReviewIds.length" @click="importSelected">确认入库</button>
        </div>
      </div>
      <p v-if="reviewMessage" class="success">{{ reviewMessage }}</p>
      <div v-if="!store.reviewItems.length" class="empty">暂无待确认结果</div>
      <div v-else class="review-list">
        <label v-for="item in store.reviewItems" :key="item.id" class="review-item">
          <input
            type="checkbox"
            :checked="selectedReviewIds.includes(item.id)"
            @change="toggleReview(item.id, ($event.target as HTMLInputElement).checked)"
          />
          <div>
            <strong>{{ item.normalized_payload.title || item.normalized_payload.content.slice(0, 42) }}</strong>
            <p>{{ item.normalized_payload.content }}</p>
            <small>{{ item.normalized_payload.type }} · {{ item.normalized_payload.source_url || 'no url' }}</small>
          </div>
        </label>
      </div>
    </section>

    <div v-if="showEdit" class="modal-backdrop" @click.self="showEdit = false">
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
                    @click="setNestedSelector(selectorTarget, candidate.selector)"
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
.workspace { min-height: 0; flex: 1; display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 12px; }
.rule-list, .panel, .review-panel { border: 1px solid var(--c-border); background: var(--c-panel); border-radius: 8px; }
.rule-list { padding: 8px; overflow: auto; }
.rule-item { width: 100%; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 10px; cursor: pointer; color: var(--c-text); }
.rule-item:hover, .rule-item.active { background: var(--c-hover); border-color: var(--c-border); }
.rule-title { display: block; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-meta { display: block; margin-top: 2px; color: var(--c-text-2); font-size: 12px; }
.panel { padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
.compact h3 { font-size: 16px; }
.actions { display: flex; gap: 8px; align-items: center; }
.btn, .btn-primary { border: 1px solid var(--c-border); border-radius: 6px; height: 32px; padding: 0 12px; cursor: pointer; color: var(--c-text); background: var(--c-panel); }
.btn:hover:not(:disabled) { background: var(--c-hover); }
.btn-primary { border-color: #1d4ed8; background: #1d4ed8; color: white; font-weight: 700; }
.btn:disabled, .btn-primary:disabled { opacity: .45; cursor: not-allowed; }
.progress-box, .target-box { border: 1px solid var(--c-border); background: var(--c-bg); border-radius: 8px; padding: 12px; }
.progress-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--c-text-2); margin-bottom: 6px; }
.progress-track { height: 7px; background: var(--c-border); border-radius: 999px; overflow: hidden; }
.progress-bar { height: 100%; background: #2563eb; transition: width .2s; }
.target-box { display: flex; flex-direction: column; gap: 8px; }
.target-box > label, .section-title { font-size: 12px; color: var(--c-text-2); font-weight: 700; }
.session-row { display: grid; grid-template-columns: minmax(140px, 1fr) auto auto auto; gap: 8px; align-items: center; }
.sessions { display: flex; flex-wrap: wrap; gap: 6px; }
.session-pill { border: 1px solid var(--c-border); background: var(--c-panel); color: var(--c-text-2); border-radius: 999px; padding: 4px 9px; font-size: 12px; cursor: pointer; }
.session-pill.active { border-color: #1d4ed8; color: #1d4ed8; background: #dbeafe; }
.session-message { color: var(--c-text-2); font-size: 12px; }
.segmented { display: inline-flex; border: 1px solid var(--c-border); border-radius: 6px; overflow: hidden; width: fit-content; }
.segmented button { border: 0; border-right: 1px solid var(--c-border); background: var(--c-panel); color: var(--c-text); height: 30px; padding: 0 10px; cursor: pointer; }
.segmented button:last-child { border-right: 0; }
.segmented button.active { background: #dbeafe; color: #1d4ed8; font-weight: 700; }
.group-grid, .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.input { width: 100%; border: 1px solid var(--c-input-border); background: var(--c-input); color: var(--c-text); border-radius: 6px; padding: 7px 9px; min-height: 34px; }
.runs, .review-list { display: flex; flex-direction: column; gap: 8px; }
.run-row { display: grid; grid-template-columns: 92px 100px 130px 120px 1fr; gap: 8px; align-items: center; padding: 9px; border: 1px solid var(--c-border); border-radius: 6px; font-size: 12px; }
.badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; width: fit-content; }
.badge.ok { background: var(--c-ok-bg); color: var(--c-ok-text); }
.badge.warn { background: var(--c-warn-bg); color: var(--c-warn-text); }
.badge.err { background: #fee2e2; color: #dc2626; }
.review-panel { max-height: 34%; min-height: 190px; padding: 14px; overflow: auto; }
.review-item { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; padding: 10px; border: 1px solid var(--c-border); border-radius: 6px; cursor: pointer; }
.review-item strong { font-weight: 700; color: var(--c-text); }
.review-item p { color: var(--c-text-2); font-size: 12px; max-height: 38px; overflow: hidden; }
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
  .inspect-toolbar, .inspector-grid { grid-template-columns: 1fr; }
}
</style>
