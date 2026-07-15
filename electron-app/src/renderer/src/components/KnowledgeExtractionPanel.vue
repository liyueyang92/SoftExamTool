<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import type { Doc } from '../stores/document'
import type { KnowledgeDomainTreeNode } from '../stores/knowledge-domain'

interface Suggestion {
  name: string
  suggested_parent_id: string
  suggested_parent_name: string
  summary: string
  source_chunk_ids: string[]
  confidence: number
}

const props = defineProps<{
  documents: Doc[]
  domainTree: KnowledgeDomainTreeNode[]
}>()

const emit = defineEmits<{
  (e: 'domains-imported'): void
}>()

// ─── Document selection ──────────────────────────────────────────────────────

const selectedDocIds = ref<Set<string>>(new Set())
const extracting = ref(false)
const extractProgress = ref('')
const extractError = ref('')
const suggestions = ref<Suggestion[]>([])
const importState = ref<Record<string, 'idle' | 'importing' | 'done'>>({})
let removeProgressListener: (() => void) | null = null

const hasSelection = computed(() => selectedDocIds.value.size > 0)

function toggleDoc(docId: string) {
  const next = new Set(selectedDocIds.value)
  if (next.has(docId)) next.delete(docId)
  else next.add(docId)
  selectedDocIds.value = next
}

function selectAll() {
  selectedDocIds.value = new Set(props.documents.map((d) => d.id))
}

function deselectAll() {
  selectedDocIds.value = new Set()
}

// ─── AI Extraction ───────────────────────────────────────────────────────────

async function startExtraction() {
  if (!hasSelection.value) return
  extracting.value = true
  extractProgress.value = '准备中…'
  extractError.value = ''
  suggestions.value = []

  // Register progress listener from main process
  removeProgressListener = window.electronAPI.onExtractKnowledgeProgress(
    (msg) => { extractProgress.value = msg.message }
  )

  try {
    const res = await window.electronAPI.extractKnowledgePoints({
      docIds: [...selectedDocIds.value],
    })
    if (res.success && res.data?.suggestions) {
      suggestions.value = res.data.suggestions as Suggestion[]
    } else {
      extractError.value = res.error || '提取失败，请重试'
    }
  } catch (e: any) {
    extractError.value = e?.message || 'AI 提取失败，请检查 AI 服务是否正常'
  } finally {
    extracting.value = false
    extractProgress.value = ''
    if (removeProgressListener) {
      removeProgressListener()
      removeProgressListener = null
    }
  }
}

onUnmounted(() => {
  if (removeProgressListener) {
    removeProgressListener()
    removeProgressListener = null
  }
})

// ─── Build flat domain options for parent adjustment ─────────────────────────

function flattenForSelect(
  nodes: KnowledgeDomainTreeNode[],
  prefix = ''
): Array<{ id: string; label: string }> {
  const result: Array<{ id: string; label: string }> = []
  for (const n of nodes) {
    result.push({ id: n.id, label: prefix + n.name })
    if (n.children?.length) {
      result.push(...flattenForSelect(n.children, prefix + '  '))
    }
  }
  return result
}

const parentOptions = computed(() => {
  return flattenForSelect(props.domainTree)
})

// ─── Approve / Reject ────────────────────────────────────────────────────────

function generateDomainId(): string {
  return 'kd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

async function approveSuggestion(suggestion: Suggestion) {
  const key = suggestion.name
  importState.value[key] = 'importing'

  // Determine level based on parent: level 2 parent → level 3 child; level 1 → level 2
  const parent = findNodeById(props.domainTree, suggestion.suggested_parent_id)
  const level = parent ? Math.min(parent.level + 1, 3) : 3

  const domain = {
    id: generateDomainId(),
    parent_id: suggestion.suggested_parent_id || null,
    name: suggestion.name,
    level,
    sort_order: 99,
    suggested_min: 30,
    weight_pct: 0,
    is_required: 1,
    outline_ref: '',
  }

  try {
    await window.electronAPI.upsertDomain(domain)
    importState.value[key] = 'done'
    suggestions.value = suggestions.value.filter((s) => s.name !== suggestion.name)
  } catch {
    importState.value[key] = 'idle'
  }
}

async function approveAll() {
  for (const s of [...suggestions.value]) {
    await approveSuggestion(s)
  }
  emit('domains-imported')
}

function rejectSuggestion(suggestion: Suggestion) {
  suggestions.value = suggestions.value.filter((s) => s.name !== suggestion.name)
}

function rejectAll() {
  suggestions.value = []
}

function findNodeById(
  nodes: KnowledgeDomainTreeNode[],
  id: string
): KnowledgeDomainTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children?.length) {
      const found = findNodeById(n.children, id)
      if (found) return found
    }
  }
  return null
}

function getConfidenceLabel(v: number): string {
  return '★'.repeat(v) + '☆'.repeat(5 - v)
}
</script>

<template>
  <div class="panel">
    <h3 class="panel-title">从文档库提取知识点</h3>

    <!-- Document selector -->
    <div class="section">
      <div class="section-header">
        <span class="label">选择文档</span>
        <span class="actions">
          <button class="btn-xs btn-ghost" @click="selectAll">全选</button>
          <button class="btn-xs btn-ghost" @click="deselectAll">取消</button>
        </span>
      </div>

      <div class="doc-list" v-if="documents.length > 0">
        <label
          v-for="doc in documents"
          :key="doc.id"
          class="doc-item"
          :class="{ checked: selectedDocIds.has(doc.id) }"
        >
          <input
            type="checkbox"
            :checked="selectedDocIds.has(doc.id)"
            @change="toggleDoc(doc.id)"
          />
          <span class="doc-title">{{ doc.title }}</span>
          <span class="doc-pages">{{ doc.page_count }}页</span>
        </label>
      </div>
      <div class="empty-hint" v-else>
        暂无文档，请先在文档库中导入教材或资料
      </div>
    </div>

    <!-- Extract button -->
    <div class="action-bar">
      <button
        class="btn-primary"
        :disabled="!hasSelection || extracting"
        @click="startExtraction"
      >
        <span v-if="extracting">⏳ {{ extractProgress || 'AI 分析中…' }}</span>
        <span v-else>🤖 AI 智能提取知识点</span>
      </button>
      <span class="hint" v-if="!hasSelection">请先选择文档</span>
    </div>

    <!-- Error -->
    <div class="error-msg" v-if="extractError">
      {{ extractError }}
    </div>

    <!-- Suggestions -->
    <div class="suggestions" v-if="suggestions.length > 0">
      <div class="section-header">
        <span class="label">提取结果（{{ suggestions.length }} 条建议）</span>
        <span class="actions">
          <button class="btn-xs btn-ghost" @click="approveAll">全部采纳</button>
          <button class="btn-xs btn-ghost btn-danger" @click="rejectAll">全部拒绝</button>
        </span>
      </div>

      <div
        v-for="s in suggestions"
        :key="s.name"
        class="sug-card"
      >
        <div class="sug-header">
          <span class="sug-name">{{ s.name }}</span>
          <span class="sug-confidence">{{ getConfidenceLabel(s.confidence) }}</span>
        </div>
        <div class="sug-summary">{{ s.summary }}</div>
        <div class="sug-meta">
          建议挂在：
          <select
            class="parent-select"
            :model-value="s.suggested_parent_id"
            @change="(e) => { s.suggested_parent_id = (e.target as HTMLSelectElement).value }"
          >
            <option
              v-for="opt in parentOptions"
              :key="opt.id"
              :value="opt.id"
            >
              {{ opt.label }}
            </option>
          </select>
          <span class="sug-source" v-if="s.source_chunk_ids?.length">
            来源：{{ s.source_chunk_ids.length }} 个文档片段
          </span>
        </div>
        <div class="sug-actions">
          <button
            class="btn-sm btn-primary"
            :disabled="importState[s.name] === 'importing'"
            @click="approveSuggestion(s)"
          >
            {{ importState[s.name] === 'importing' ? '导入中…' : '采纳' }}
          </button>
          <button class="btn-sm btn-ghost" @click="rejectSuggestion(s)">拒绝</button>
        </div>
      </div>
    </div>

    <!-- Empty state after extraction -->
    <div class="empty-hint" v-if="!extracting && suggestions.length === 0 && !extractError && selectedDocIds.size > 0 && (extracting === false)">
      选择文档后点击「AI 智能提取」按钮，AI 将分析文档内容并补充新知识点
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow-y: auto;
  padding: 8px 0;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  padding: 0;
  color: var(--c-accent);
}

.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.label {
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted, #888);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.actions {
  display: flex;
  gap: 4px;
}

.doc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 4px;
}

.doc-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.1s;
}

.doc-item:hover {
  background: var(--c-panel);
}

.doc-item.checked {
  background: var(--c-panel);
}

.doc-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-pages {
  color: var(--c-text-muted, #999);
  font-size: 11px;
}

.action-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hint {
  font-size: 11px;
  color: var(--c-text-muted, #999);
}

.error-msg {
  background: #fef2f2;
  color: #dc2626;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sug-card {
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--c-bg);
}

.sug-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sug-name {
  font-size: 13px;
  font-weight: 600;
}

.sug-confidence {
  font-size: 11px;
  color: #f59e0b;
  letter-spacing: 1px;
}

.sug-summary {
  font-size: 11px;
  color: var(--c-text-muted, #888);
}

.sug-meta {
  font-size: 11px;
  color: var(--c-text-muted, #888);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.parent-select {
  font-size: 11px;
  padding: 1px 4px;
  border: 1px solid var(--c-border);
  border-radius: 3px;
  background: var(--c-bg);
  color: var(--c-text);
  max-width: 200px;
}

.sug-source {
  color: var(--c-text-muted, #aaa);
}

.sug-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.empty-hint {
  font-size: 12px;
  color: var(--c-text-muted, #aaa);
  text-align: center;
  padding: 16px 0;
}

/* Reuse button styles from the app */
.btn-primary {
  padding: 6px 14px;
  font-size: 12px;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  background: var(--c-accent);
  color: #fff;
  transition: opacity 0.15s;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 11px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  background: var(--c-accent);
  color: #fff;
}

.btn-sm:disabled {
  opacity: 0.5;
}

.btn-ghost {
  background: transparent;
  color: var(--c-text);
  border: 1px solid var(--c-border);
}

.btn-xs {
  padding: 2px 6px;
  font-size: 10px;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  background: transparent;
  color: var(--c-text);
}

.btn-xs:hover {
  background: var(--c-border);
}

.btn-danger {
  color: #dc2626 !important;
}

.btn-danger:hover {
  background: #fee2e2;
}
</style>
