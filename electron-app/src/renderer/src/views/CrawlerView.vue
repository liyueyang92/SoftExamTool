<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useCrawlerStore, type CrawlerRule } from '../stores/crawler'

const store = useCrawlerStore()

const showEdit = ref(false)
const editTarget = ref<Partial<CrawlerRule>>({})
const saving = ref(false)
const activeRun = ref<{ taskId: string; runId: string; ruleId: string } | null>(null)
const runProgress = ref(0)
const runMessage = ref('')
const runError = ref('')
const testResult = ref<{ count: number; samples: unknown[] } | null>(null)
const testing = ref(false)
const testUrl = ref('')
const testError = ref('')
const selectedRuleId = ref<string | null>(null)

const selectedRule = computed(() => store.rules.find((r) => r.id === selectedRuleId.value) ?? null)

onMounted(async () => {
  await store.fetchRules()
  // Watch task progress
  window.electronAPI.onTaskProgress((msg) => {
    if (activeRun.value && msg.taskId === activeRun.value.taskId) {
      runProgress.value = msg.progress
      runMessage.value = msg.message
    }
  })
})

function openNew() {
  editTarget.value = {
    site_name: '',
    url_template: 'https://example.com/questions?page={page}',
    item_selector: '.question-item',
    question_field: '.question-content',
    options_field: '.option',
    answer_field: '.answer',
    expl_field: '.explanation',
    max_pages: 5,
    delay_ms: 1500,
    is_enabled: 1,
  }
  testResult.value = null
  testUrl.value = editTarget.value.url_template?.replace('{page}', '1') ?? ''
  showEdit.value = true
}

function openEdit(rule: CrawlerRule) {
  editTarget.value = { ...rule }
  testResult.value = null
  testUrl.value = rule.url_template.replace('{page}', '1')
  showEdit.value = true
}

async function save() {
  if (!editTarget.value.site_name?.trim() || !editTarget.value.url_template?.trim()) return
  saving.value = true
  try {
    await store.upsert(editTarget.value)
    showEdit.value = false
  } finally {
    saving.value = false
  }
}

async function doTest() {
  testError.value = ''
  testResult.value = null
  testing.value = true
  try {
    const res = await store.testCrawl(editTarget.value, testUrl.value)
    testResult.value = res as { count: number; samples: unknown[] }
  } catch (e) {
    testError.value = String(e)
  } finally {
    testing.value = false
  }
}

async function runCrawl(ruleId: string) {
  runProgress.value = 0
  runMessage.value = '准备开始…'
  runError.value = ''
  activeRun.value = null
  try {
    const result = await store.run(ruleId)
    activeRun.value = { ...result, ruleId }
    await store.fetchRuns(ruleId)
  } catch (e) {
    runError.value = String(e)
  }
}

async function selectRule(ruleId: string) {
  selectedRuleId.value = ruleId
  await store.fetchRuns(ruleId)
}

function statusColor(status: string) {
  if (status === 'completed') return 'ok'
  if (status === 'failed') return 'err'
  return 'warn'
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="crawler-view">
    <!-- Header -->
    <div class="view-header">
      <h2 class="view-title">爬虫引擎</h2>
      <button class="btn-primary" @click="openNew">+ 新建规则</button>
    </div>

    <div class="main-layout">
      <!-- Rule list -->
      <div class="rule-list">
        <div v-if="store.loading" class="empty-tip">加载中…</div>
        <div v-else-if="store.rules.length === 0" class="empty-tip">
          <div style="font-size:32px;margin-bottom:8px">🕷</div>
          <div>还没有爬虫规则</div>
          <div style="font-size:12px;margin-top:4px;color:var(--c-text-3)">点击上方「新建规则」</div>
        </div>
        <div
          v-for="rule in store.rules"
          :key="rule.id"
          class="rule-item"
          :class="{ active: selectedRuleId === rule.id }"
          @click="selectRule(rule.id)"
        >
          <div class="rule-info">
            <div class="rule-name">{{ rule.site_name }}</div>
            <div class="rule-meta">
              已抓取 {{ rule.total_crawled }} 题 &nbsp;·&nbsp; {{ rule.max_pages }} 页
            </div>
          </div>
          <div class="rule-actions">
            <button class="icon-btn" @click.stop="openEdit(rule)" title="编辑">✎</button>
            <button class="icon-btn btn-run" @click.stop="runCrawl(rule.id)" title="运行">▷</button>
            <button class="icon-btn danger" @click.stop="store.remove(rule.id)" title="删除">✕</button>
          </div>
        </div>
      </div>

      <!-- Right panel: runs + progress -->
      <div class="right-panel">
        <div v-if="!selectedRule" class="empty-tip" style="height:100%;display:flex;align-items:center;justify-content:center;">
          <div style="text-align:center;color:var(--c-border-2)">
            <div style="font-size:32px;margin-bottom:8px">←</div>
            <div>选择左侧规则查看运行记录</div>
          </div>
        </div>
        <template v-else>
          <div class="panel-header">
            <h3>{{ selectedRule.site_name }}</h3>
            <div style="display:flex;gap:8px">
              <button class="btn-sm" @click="openEdit(selectedRule)">编辑</button>
              <button class="btn-sm btn-primary" @click="runCrawl(selectedRule.id)">▷ 运行</button>
            </div>
          </div>

          <!-- Live progress -->
          <div v-if="activeRun && activeRun.ruleId === selectedRule.id" class="progress-card">
            <div class="progress-label">
              <span>{{ runMessage }}</span>
              <span>{{ runProgress }}%</span>
            </div>
            <div class="progress-bg">
              <div class="progress-bar" :style="{ width: runProgress + '%' }"></div>
            </div>
            <p v-if="runError" class="error-text">{{ runError }}</p>
          </div>

          <!-- URL template info -->
          <div class="url-info">
            <span class="label-sm">URL模板：</span>
            <code class="code-text">{{ selectedRule.url_template }}</code>
          </div>

          <!-- Run history -->
          <div class="runs-header">运行历史</div>
          <div v-if="store.runs.length === 0" class="empty-tip" style="min-height:60px;">暂无运行记录</div>
          <div v-else class="runs-list">
            <div v-for="run in store.runs" :key="run.id" class="run-item">
              <span class="run-status" :class="statusColor(run.status)">{{ run.status }}</span>
              <div class="run-stats">
                找到 {{ run.total_found }} / 保存 {{ run.total_saved }}
              </div>
              <div class="run-time">{{ formatDate(run.started_at) }}</div>
              <div v-if="run.error_msg" class="run-error">{{ run.error_msg.slice(0, 60) }}</div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Edit / Create modal -->
    <div v-if="showEdit" class="modal-backdrop" @click.self="showEdit = false">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ editTarget.id ? '编辑规则' : '新建规则' }}</h3>
          <button class="close-btn" @click="showEdit = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="form-col">
              <div class="form-group">
                <label>站点名称</label>
                <input v-model="editTarget.site_name" class="input-sm" placeholder="例：牛客题库" />
              </div>
              <div class="form-group">
                <label>URL 模板 <span class="hint">({page} 替换页码)</span></label>
                <input v-model="editTarget.url_template" class="input-sm" placeholder="https://…?page={page}" />
              </div>
              <div class="form-row-2">
                <div class="form-group">
                  <label>最大页数</label>
                  <input v-model.number="editTarget.max_pages" type="number" min="1" max="50" class="input-sm" />
                </div>
                <div class="form-group">
                  <label>延迟(ms)</label>
                  <input v-model.number="editTarget.delay_ms" type="number" min="500" class="input-sm" />
                </div>
              </div>
            </div>
            <div class="form-col">
              <div class="form-group">
                <label>题目容器选择器 <span class="hint">(CSS)</span></label>
                <input v-model="editTarget.item_selector" class="input-sm" placeholder=".question-item" />
              </div>
              <div class="form-group">
                <label>题目文本选择器</label>
                <input v-model="editTarget.question_field" class="input-sm" placeholder=".question-content" />
              </div>
              <div class="form-group">
                <label>选项选择器 <span class="hint">(可选)</span></label>
                <input v-model="editTarget.options_field" class="input-sm" placeholder=".option" />
              </div>
              <div class="form-group">
                <label>答案选择器 <span class="hint">(可选)</span></label>
                <input v-model="editTarget.answer_field" class="input-sm" placeholder=".answer" />
              </div>
              <div class="form-group">
                <label>解析选择器 <span class="hint">(可选)</span></label>
                <input v-model="editTarget.expl_field" class="input-sm" placeholder=".explanation" />
              </div>
            </div>
          </div>

          <!-- Test panel -->
          <div class="test-panel">
            <div class="test-header">
              <span class="label-sm">测试抓取</span>
              <input v-model="testUrl" class="input-sm test-url" placeholder="测试 URL" />
              <button class="btn-sm" @click="doTest" :disabled="testing">{{ testing ? '测试中…' : '测试' }}</button>
            </div>
            <p v-if="testError" class="error-text">{{ testError }}</p>
            <div v-if="testResult" class="test-result">
              <span class="success-text">找到 {{ testResult.count }} 题</span>
              <div v-if="(testResult.samples as unknown[]).length" class="samples">
                <div v-for="(s, i) in (testResult.samples as Array<{content:string;type:string}>)" :key="i" class="sample-item">
                  <span class="sample-type">{{ s.type }}</span>
                  {{ s.content?.slice(0, 80) }}…
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-sm" @click="showEdit = false">取消</button>
          <button class="btn-sm btn-primary" @click="save" :disabled="saving">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crawler-view { display: flex; flex-direction: column; gap: 16px; height: 100%; }
.view-header { display: flex; align-items: center; gap: 12px; }
.view-title { font-size: 20px; font-weight: 700; color: var(--c-text); flex: 1; }
.btn-primary { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { background: var(--c-border); border: none; border-radius: 6px; color: var(--c-text); padding: 6px 12px; font-size: 13px; cursor: pointer; }
.btn-sm:hover:not(:disabled) { background: var(--c-border-2); }
.btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }

.main-layout { flex: 1; display: grid; grid-template-columns: 260px 1fr; gap: 12px; overflow: hidden; }

.rule-list { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; overflow-y: auto; }
.rule-item { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--c-border); cursor: pointer; }
.rule-item:hover { background: #1a2740; }
.rule-item.active { background: #1e3a5f; }
.rule-info { flex: 1; min-width: 0; }
.rule-name { font-size: 13px; font-weight: 600; color: var(--c-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rule-meta { font-size: 11px; color: var(--c-text-3); margin-top: 2px; }
.rule-actions { display: flex; gap: 4px; flex-shrink: 0; }
.icon-btn { background: none; border: 1px solid var(--c-border-2); border-radius: 4px; color: var(--c-text-2); width: 26px; height: 26px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 13px; }
.icon-btn:hover { border-color: var(--c-text-2); color: var(--c-text); }
.icon-btn.btn-run:hover { border-color: #4ade80; color: #4ade80; }
.icon-btn.danger:hover { border-color: #f87171; color: #f87171; }

.right-panel { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.panel-header { display: flex; align-items: center; justify-content: space-between; }
.panel-header h3 { font-size: 15px; font-weight: 600; color: var(--c-text); }

.progress-card { background: var(--c-bg); border-radius: 8px; padding: 12px; }
.progress-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--c-text-2); margin-bottom: 6px; }
.progress-bg { height: 6px; background: var(--c-border); border-radius: 3px; overflow: hidden; }
.progress-bar { height: 100%; background: #1d4ed8; border-radius: 3px; transition: width 0.3s; }

.url-info { display: flex; align-items: center; gap: 8px; }
.label-sm { font-size: 12px; color: var(--c-text-2); white-space: nowrap; }
.code-text { font-family: monospace; font-size: 12px; color: #86efac; background: var(--c-bg); padding: 2px 6px; border-radius: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; }

.runs-header { font-size: 12px; font-weight: 600; color: var(--c-text-3); text-transform: uppercase; letter-spacing: 0.05em; }
.runs-list { display: flex; flex-direction: column; gap: 6px; }
.run-item { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 6px; padding: 8px 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.run-status { font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; }
.run-status.ok { background: var(--c-ok-bg); color: #4ade80; }
.run-status.err { background: #450a0a; color: #f87171; }
.run-status.warn { background: #431407; color: #fb923c; }
.run-stats { font-size: 12px; color: var(--c-text-2); flex: 1; }
.run-time { font-size: 11px; color: var(--c-border-2); }
.run-error { font-size: 11px; color: #f87171; width: 100%; }

.empty-tip { text-align: center; padding: 32px; color: var(--c-border-2); font-size: 13px; }
.error-text { color: #f87171; font-size: 13px; }
.success-text { color: #4ade80; font-size: 13px; }

/* Modal */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 12px; width: 780px; max-height: 85vh; display: flex; flex-direction: column; }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--c-border); }
.modal-header h3 { font-size: 16px; font-weight: 700; color: var(--c-text); }
.close-btn { background: none; border: none; color: var(--c-text-2); font-size: 18px; cursor: pointer; }
.modal-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--c-border); }

.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.form-col { display: flex; flex-direction: column; gap: 10px; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: var(--c-text-2); }
.form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.input-sm { background: var(--c-bg); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 6px 10px; font-size: 13px; width: 100%; }
.hint { color: var(--c-border-2); font-size: 11px; }

.test-panel { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.test-header { display: flex; align-items: center; gap: 8px; }
.test-url { flex: 1; }
.test-result { display: flex; flex-direction: column; gap: 6px; }
.samples { display: flex; flex-direction: column; gap: 4px; }
.sample-item { font-size: 12px; color: #cbd5e1; background: var(--c-panel); border-radius: 4px; padding: 6px 8px; }
.sample-type { display: inline-block; background: #1e3a5f; color: var(--c-brand); border-radius: 3px; padding: 1px 4px; font-size: 10px; margin-right: 6px; }
</style>
