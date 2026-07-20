<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useKnowledgeDomainStore, type KnowledgeDomainTreeNode } from '../stores/knowledge-domain'
import { useDocumentStore } from '../stores/document'
import KnowledgeDomainTreeItem from '../components/KnowledgeDomainTreeItem.vue'
import KnowledgeExtractionPanel from '../components/KnowledgeExtractionPanel.vue'

const domainStore = useKnowledgeDomainStore()
const documentStore = useDocumentStore()

// ─── State ──────────────────────────────────────────────────────────────────

const selectedId = ref<string | null>(null)
const editing = ref(false)
const editingId = ref<string | null>(null)
const addingChildOf = ref<string | null>(null)

// Form fields
const formName = ref('')
const formParentId = ref<string | null>(null)
const formLevel = ref(3)
const formSortOrder = ref(99)
const formSuggestedMin = ref(30)
const formWeightPct = ref(0)
const formIsRequired = ref(true)
const formOutlineRef = ref('')

// Import state
const importing = ref(false)
const importMsg = ref('')

// ─── Computed ───────────────────────────────────────────────────────────────

const selectedNode = computed(() => {
  if (!selectedId.value) return null
  return findNodeById(domainStore.tree, selectedId.value)
})

const selectedStats = computed(() => {
  if (!selectedNode.value) return null
  return {
    totalChildren: countDescendants(selectedNode.value),
    level: selectedNode.value.level,
    suggestedMin: selectedNode.value.suggested_min,
    weightPct: selectedNode.value.weight_pct,
    outlineRef: selectedNode.value.outline_ref,
    isRequired: selectedNode.value.is_required === 1,
  }
})

const parentOptions = computed(() => {
  const options: Array<{ id: string; label: string }> = []
  for (const n of domainStore.flatList) {
    if (n.level < 3) {
      options.push({ id: n.id, label: '  '.repeat(n.level - 1) + n.name })
    }
  }
  return options
})

// ─── Tree operations ────────────────────────────────────────────────────────

function selectNode(id: string) {
  selectedId.value = id
  editing.value = false
  editingId.value = null
  addingChildOf.value = null
}

function startEdit(node: KnowledgeDomainTreeNode) {
  editing.value = true
  editingId.value = node.id
  addingChildOf.value = null
  formName.value = node.name
  formParentId.value = node.parent_id
  formLevel.value = node.level
  formSortOrder.value = node.sort_order
  formSuggestedMin.value = node.suggested_min
  formWeightPct.value = node.weight_pct
  formIsRequired.value = node.is_required === 1
  formOutlineRef.value = node.outline_ref
}

function startAddChild(parentId: string) {
  addingChildOf.value = parentId
  editing.value = true
  editingId.value = null
  formName.value = ''
  formParentId.value = parentId
  formLevel.value = Math.min(3, (findNodeById(domainStore.tree, parentId)?.level ?? 1) + 1)
  formSortOrder.value = 99
  formSuggestedMin.value = 30
  formWeightPct.value = 0
  formIsRequired.value = true
  formOutlineRef.value = ''
}

function startAddRoot() {
  addingChildOf.value = null
  editing.value = true
  editingId.value = null
  formName.value = ''
  formParentId.value = null
  formLevel.value = 1
  formSortOrder.value = 99
  formSuggestedMin.value = 180
  formWeightPct.value = 5
  formIsRequired.value = true
  formOutlineRef.value = ''
}

function cancelEdit() {
  editing.value = false
  editingId.value = null
  addingChildOf.value = null
}

async function saveDomain() {
  if (!formName.value.trim()) return

  const id = editingId.value || ('kd-x-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6))

  await domainStore.upsert({
    id,
    parent_id: formParentId.value,
    name: formName.value.trim(),
    level: formLevel.value,
    sort_order: formSortOrder.value,
    suggested_min: formSuggestedMin.value,
    weight_pct: formWeightPct.value,
    is_required: formIsRequired.value ? 1 : 0,
    outline_ref: formOutlineRef.value,
  })

  cancelEdit()
  selectedId.value = id
}

async function deleteSelected() {
  if (!selectedId.value) return
  const node = selectedNode.value
  if (!node) return

  const hasChildren = node.children && node.children.length > 0
  const msg = hasChildren
    ? `确定删除「${node.name}」及其所有子知识点吗？`
    : `确定删除「${node.name}」吗？`

  if (!confirm(msg)) return
  await domainStore.remove(selectedId.value)
  selectedId.value = null
}

async function handleImportOutline() {
  const ok = confirm('重新导入大纲将清空当前所有知识点数据，是否继续？')
  if (!ok) return

  importing.value = true
  importMsg.value = ''

  try {
    const res = await domainStore.importOutline(true)
    if (res.success) {
      importMsg.value = `成功导入 ${res.data?.imported ?? 0} 条知识点`
    } else {
      const errDetail = typeof res.error === 'object' ? (res.error as any).message : String(res.error)
      importMsg.value = '导入失败: ' + (errDetail || '未知错误')
    }
  } catch (e: any) {
    importMsg.value = '导入失败: ' + (e?.message || String(e))
  } finally {
    importing.value = false
    setTimeout(() => { importMsg.value = '' }, 4000)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findNodeById(nodes: KnowledgeDomainTreeNode[], id: string): KnowledgeDomainTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children?.length) {
      const found = findNodeById(n.children, id)
      if (found) return found
    }
  }
  return null
}

function countDescendants(node: KnowledgeDomainTreeNode): number {
  let count = node.children.length
  for (const c of node.children) {
    count += countDescendants(c)
  }
  return count
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  await Promise.all([
    domainStore.loadTree(),
    domainStore.loadFlatList(),
    documentStore.fetchAll(),
  ])

})
</script>

<template>
  <div class="view">
    <!-- Left panel: Tree -->
    <div class="left-panel">
      <div class="toolbar">
        <h2 class="title">知识领域管理</h2>
        <div class="toolbar-actions">
          <button class="btn-sm btn-primary" @click="startAddRoot">+ 新增一级域</button>
          <button class="btn-sm btn-ghost" :disabled="importing" @click="handleImportOutline">
            {{ importing ? '⏳ 导入中…' : '📥 从大纲文件导入' }}
          </button>
        </div>
      </div>

      <!-- Import status message -->
      <div class="import-msg" v-if="importMsg" :class="{ error: importMsg.includes('失败') }">
        {{ importMsg }}
      </div>

      <div class="tree-scroller" v-if="domainStore.tree.length > 0">
        <KnowledgeDomainTreeItem
          v-for="node in domainStore.tree"
          :key="node.id"
          :node="node"
          :depth="0"
          :selected-id="selectedId"
          @select="selectNode"
          @add-child="startAddChild"
          @edit="startEdit"
          @delete="deleteSelected"
        />
      </div>

      <div class="empty-state" v-else-if="!domainStore.loading">
        <p>暂无知识点数据</p>
        <button class="btn-sm btn-primary" @click="handleImportOutline">从大纲文件导入</button>
      </div>

      <div class="loading" v-else>
        加载中…
      </div>

      <!-- Edit form -->
      <div class="edit-form" v-if="editing">
        <h4>{{ editingId ? '编辑知识点' : '新增知识点' }}</h4>
        <div class="form-row">
          <label>名称</label>
          <input v-model="formName" type="text" placeholder="知识点名称" />
        </div>
        <div class="form-row">
          <label>父节点</label>
          <select v-model="formParentId">
            <option :value="null">（无，作为一级域）</option>
            <option v-for="opt in parentOptions" :key="opt.id" :value="opt.id">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="form-row">
          <label>层级</label>
          <select v-model="formLevel">
            <option :value="1">一级</option>
            <option :value="2">二级</option>
            <option :value="3">三级</option>
          </select>
        </div>
        <div class="form-row half">
          <label>建议学时(分钟)</label>
          <input v-model.number="formSuggestedMin" type="number" min="0" />
        </div>
        <div class="form-row half">
          <label>权重(%)</label>
          <input v-model.number="formWeightPct" type="number" min="0" max="100" step="0.1" />
        </div>
        <div class="form-row half">
          <label>大纲参考</label>
          <input v-model="formOutlineRef" type="text" placeholder="如：第1章" />
        </div>
        <div class="form-row half">
          <label>排序</label>
          <input v-model.number="formSortOrder" type="number" min="0" />
        </div>
        <div class="form-row">
          <label>
            <input v-model="formIsRequired" type="checkbox" />
            必学知识点
          </label>
        </div>
        <div class="form-actions">
          <button class="btn-sm btn-primary" :disabled="!formName.trim()" @click="saveDomain">
            {{ editingId ? '保存' : '创建' }}
          </button>
          <button class="btn-sm btn-ghost" @click="cancelEdit">取消</button>
        </div>
      </div>

      <!-- Selected node info -->
      <div class="selected-info" v-if="!editing && selectedNode">
        <h4>{{ selectedNode.name }}</h4>
        <div class="info-grid" v-if="selectedStats">
          <div class="info-item">
            <span class="info-label">层级</span>
            <span class="info-value">{{ selectedStats.level }}级</span>
          </div>
          <div class="info-item">
            <span class="info-label">子节点</span>
            <span class="info-value">{{ selectedStats.totalChildren }}个</span>
          </div>
          <div class="info-item">
            <span class="info-label">建议学时</span>
            <span class="info-value">{{ selectedStats.suggestedMin }}分钟</span>
          </div>
          <div class="info-item">
            <span class="info-label">权重</span>
            <span class="info-value">{{ selectedStats.weightPct }}%</span>
          </div>
          <div class="info-item" v-if="selectedStats.outlineRef">
            <span class="info-label">大纲参考</span>
            <span class="info-value">{{ selectedStats.outlineRef }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">必学</span>
            <span class="info-value">{{ selectedStats.isRequired ? '是' : '否' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Right panel: Document extraction -->
    <div class="right-panel">
      <KnowledgeExtractionPanel
        :documents="documentStore.documents"
        :domain-tree="domainStore.tree"
        @domains-imported="domainStore.loadTree()"
      />
    </div>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  gap: 0;
  height: 100%;
  overflow: hidden;
}

/* ─── Left panel ─────────────────────────────────────────────────────────── */

.left-panel {
  width: 60%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--c-border);
  padding: 16px;
  overflow: hidden;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.title {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  color: var(--c-text);
}

.toolbar-actions {
  display: flex;
  gap: 6px;
}

.tree-scroller {
  flex: 1;
  overflow-y: auto;
  margin: -4px -8px;
  padding: 4px 8px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 0;
  color: var(--c-text-muted, #888);
}

.loading {
  text-align: center;
  padding: 24px;
  color: var(--c-text-muted, #888);
}

/* ─── Edit form ──────────────────────────────────────────────────────────── */

.edit-form {
  border: 1px solid var(--c-accent);
  border-radius: 8px;
  padding: 12px;
  margin-top: 8px;
  flex-shrink: 0;
  background: var(--c-bg);
}

.edit-form h4 {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: var(--c-accent);
}

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.form-row.half {
  display: inline-flex;
  width: 50%;
}

.form-row label {
  font-size: 11px;
  color: var(--c-text-muted, #888);
  min-width: 80px;
  text-align: right;
}

.form-row input[type='text'],
.form-row input[type='number'],
.form-row select {
  flex: 1;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  background: var(--c-bg);
  color: var(--c-text);
}

.form-row input[type='checkbox'] {
  margin: 0;
}

.form-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}

/* ─── Selected info ──────────────────────────────────────────────────────── */

.selected-info {
  border-top: 1px solid var(--c-border);
  padding-top: 10px;
  margin-top: 8px;
  flex-shrink: 0;
}

.selected-info h4 {
  margin: 0 0 6px 0;
  font-size: 14px;
}

.info-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.info-item {
  display: flex;
  gap: 4px;
  font-size: 11px;
}

.info-label {
  color: var(--c-text-muted, #888);
}

.info-value {
  font-weight: 600;
}

/* ─── Right panel ────────────────────────────────────────────────────────── */

.right-panel {
  width: 40%;
  padding: 16px;
  overflow: hidden;
}

/* ─── Shared button styles ───────────────────────────────────────────────── */

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
}

.btn-ghost {
  background: transparent;
  color: var(--c-text);
  border: 1px solid var(--c-border);
}

.btn-ghost:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ─── Import message ─────────────────────────────────────────────────────── */

.import-msg {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 5px;
  background: #f0fdf4;
  color: #166534;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.import-msg.error {
  background: #fef2f2;
  color: #dc2626;
}
</style>
