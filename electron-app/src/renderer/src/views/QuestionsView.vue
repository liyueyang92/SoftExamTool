<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useQuestionStore, type Question } from '../stores/question'

const store = useQuestionStore()

const searchQ = ref('')
const searching = ref(false)
const searchResults = ref<Question[]>([])
const showEdit = ref(false)
const showImport = ref(false)
const editTarget = ref<Partial<Question> | null>(null)
const importText = ref('')
const importError = ref('')
const importSuccess = ref('')
const saving = ref(false)
const importLoading = ref(false)

const typeLabels: Record<string, string> = { single: '单选', multiple: '多选', case: '案例', essay: '论文' }
const diffLabel = (d: number) => ['', '★☆☆☆☆', '★★☆☆☆', '★★★☆☆', '★★★★☆', '★★★★★'][d] ?? d

const displayList = computed(() => searchQ.value.trim() ? searchResults.value : store.questions)

onMounted(async () => {
  await Promise.all([store.fetchPage(), store.loadStats()])
})

async function doSearch() {
  if (!searchQ.value.trim()) { searchResults.value = []; return }
  searching.value = true
  try {
    searchResults.value = await store.search(searchQ.value.trim())
  } finally {
    searching.value = false
  }
}

function clearSearch() { searchQ.value = ''; searchResults.value = [] }

async function applyFilter(f: Record<string, unknown>) {
  store.setFilter(f)
  await store.fetchPage()
}

function openNew() {
  editTarget.value = { type: 'single', content: '', options: ['A. ', 'B. ', 'C. ', 'D. '], answer: 'A', explanation: '', knowledge_tags: [], difficulty: 3, source_type: 'manual' }
  showEdit.value = true
}

function openEdit(q: Question) {
  editTarget.value = { ...q, knowledge_tags: [...q.knowledge_tags] }
  showEdit.value = true
}

async function saveQuestion() {
  if (!editTarget.value?.content?.trim()) return
  saving.value = true
  try {
    if (editTarget.value.id) {
      await store.update(editTarget.value.id, editTarget.value)
    } else {
      await store.insert(editTarget.value as Omit<Question, 'id' | 'created_at' | 'is_favorite'>)
    }
    showEdit.value = false
  } finally {
    saving.value = false
  }
}

async function deleteQuestion(q: Question) {
  if (!confirm(`确认删除题目：${q.content.slice(0, 40)}…`)) return
  await store.remove(q.id)
}

function addOption() {
  if (!editTarget.value) return
  const opts = editTarget.value.options ?? []
  const letter = String.fromCharCode(65 + opts.length)
  editTarget.value.options = [...opts, `${letter}. `]
}

function removeOption(i: number) {
  if (!editTarget.value?.options) return
  editTarget.value.options = editTarget.value.options.filter((_, idx) => idx !== i)
}

async function doImport() {
  importError.value = ''; importSuccess.value = ''
  let data: unknown[]
  try {
    data = JSON.parse(importText.value)
    if (!Array.isArray(data)) throw new Error('必须是 JSON 数组')
  } catch (e) {
    importError.value = `JSON 解析失败：${(e as Error).message}`
    return
  }
  importLoading.value = true
  try {
    const count = await store.batchImport(data)
    importSuccess.value = `成功导入 ${count} 道题`
    importText.value = ''
  } catch (e) {
    importError.value = String(e)
  } finally {
    importLoading.value = false
  }
}

const tagInput = ref('')
function addTag() {
  const t = tagInput.value.trim()
  if (!t || !editTarget.value) return
  editTarget.value.knowledge_tags = [...(editTarget.value.knowledge_tags ?? []), t]
  tagInput.value = ''
}
function removeTag(i: number) {
  editTarget.value!.knowledge_tags!.splice(i, 1)
}

const totalQuestions = computed(() => (store.stats.total as number) ?? 0)
const todayAnswered = computed(() => (store.stats.todayAnswered as number) ?? 0)
const todayCorrect = computed(() => (store.stats.todayCorrect as number) ?? 0)
const todayRate = computed(() => todayAnswered.value ? Math.round(todayCorrect.value / todayAnswered.value * 100) : 0)
</script>

<template>
  <div class="qview">
    <!-- Stats row -->
    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-val">{{ totalQuestions }}</div>
        <div class="stat-label">题目总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{{ todayAnswered }}</div>
        <div class="stat-label">今日作答</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{{ todayRate }}%</div>
        <div class="stat-label">今日正确率</div>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar">
      <div class="search-wrap">
        <input v-model="searchQ" class="search-input" placeholder="全文搜索题目…" @keyup.enter="doSearch" />
        <button class="btn-sm btn-primary" @click="doSearch" :disabled="searching">搜索</button>
        <button v-if="searchQ" class="btn-sm" @click="clearSearch">清除</button>
      </div>

      <div class="filter-wrap">
        <select class="select-sm" @change="applyFilter({ type: ($event.target as HTMLSelectElement).value || undefined, page: 1 })">
          <option value="">全部题型</option>
          <option v-for="(label, val) in typeLabels" :key="val" :value="val">{{ label }}</option>
        </select>
        <select class="select-sm" @change="applyFilter({ difficulty: Number(($event.target as HTMLSelectElement).value) || undefined, page: 1 })">
          <option value="">全部难度</option>
          <option v-for="d in [1,2,3,4,5]" :key="d" :value="d">{{ diffLabel(d) }}</option>
        </select>
        <label class="fav-toggle">
          <input type="checkbox" @change="applyFilter({ is_favorite: ($event.target as HTMLInputElement).checked || undefined, page: 1 })" />
          仅收藏
        </label>
      </div>

      <div class="btn-group">
        <button class="btn-sm btn-primary" @click="openNew">+ 新建题目</button>
        <button class="btn-sm" @click="showImport = true">批量导入</button>
      </div>
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <div v-if="store.loading" class="loading-tip">加载中…</div>
      <div v-else-if="displayList.length === 0" class="empty-tip">暂无题目</div>
      <table v-else class="q-table">
        <thead>
          <tr>
            <th style="width:50px">题型</th>
            <th>题目</th>
            <th style="width:80px">难度</th>
            <th style="width:120px">知识点</th>
            <th style="width:100px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="q in displayList" :key="q.id">
            <td><span class="type-badge" :class="q.type">{{ typeLabels[q.type] }}</span></td>
            <td class="content-cell">{{ q.content.slice(0, 80) }}{{ q.content.length > 80 ? '…' : '' }}</td>
            <td class="diff-cell">{{ diffLabel(q.difficulty) }}</td>
            <td>
              <span v-for="tag in q.knowledge_tags.slice(0,2)" :key="tag" class="tag">{{ tag }}</span>
            </td>
            <td>
              <div class="action-btns">
                <button class="icon-btn" :class="q.is_favorite ? 'fav-on' : ''" @click="store.toggleFavorite(q.id)" title="收藏">★</button>
                <button class="icon-btn" @click="openEdit(q)" title="编辑">✎</button>
                <button class="icon-btn danger" @click="deleteQuestion(q)" title="删除">✕</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="!searchQ && store.total > (store.filter.pageSize ?? 20)" class="pagination">
      <button class="btn-sm" :disabled="(store.filter.page ?? 1) <= 1" @click="store.setFilter({ page: (store.filter.page ?? 1) - 1 }); store.fetchPage()">上一页</button>
      <span>第 {{ store.filter.page }} 页 / 共 {{ Math.ceil(store.total / (store.filter.pageSize ?? 20)) }} 页</span>
      <button class="btn-sm" :disabled="(store.filter.page ?? 1) >= Math.ceil(store.total / (store.filter.pageSize ?? 20))" @click="store.setFilter({ page: (store.filter.page ?? 1) + 1 }); store.fetchPage()">下一页</button>
    </div>

    <!-- Edit/Create Modal -->
    <div v-if="showEdit" class="modal-backdrop" @click.self="showEdit = false">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ editTarget?.id ? '编辑题目' : '新建题目' }}</h3>
          <button class="close-btn" @click="showEdit = false">✕</button>
        </div>
        <div class="modal-body" v-if="editTarget">
          <div class="form-row">
            <label>题型</label>
            <select v-model="editTarget.type" class="select-sm">
              <option v-for="(label, val) in typeLabels" :key="val" :value="val">{{ label }}</option>
            </select>
            <label style="margin-left:12px">难度</label>
            <select v-model="editTarget.difficulty" class="select-sm">
              <option v-for="d in [1,2,3,4,5]" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>

          <div class="form-row col">
            <label>题目内容 *</label>
            <textarea v-model="editTarget.content" class="textarea" rows="4" placeholder="题目正文…"></textarea>
          </div>

          <div v-if="editTarget.type === 'single' || editTarget.type === 'multiple'" class="form-row col">
            <label>选项</label>
            <div v-for="(_opt, i) in editTarget.options" :key="i" class="option-row">
              <input v-model="editTarget.options![i]" class="input-sm" placeholder="选项内容" />
              <button class="icon-btn danger" @click="removeOption(i)">✕</button>
            </div>
            <button class="btn-sm" @click="addOption" style="margin-top:4px">+ 添加选项</button>
          </div>

          <div v-if="editTarget.type === 'single' || editTarget.type === 'multiple'" class="form-row">
            <label>答案</label>
            <input v-model="editTarget.answer" class="input-sm" style="width:120px" placeholder="如 A 或 A,C" />
          </div>

          <div class="form-row col">
            <label>解析</label>
            <textarea v-model="editTarget.explanation" class="textarea" rows="3" placeholder="答题解析（可选）"></textarea>
          </div>

          <div class="form-row col">
            <label>知识点标签</label>
            <div class="tags-row">
              <span v-for="(tag, i) in editTarget.knowledge_tags" :key="i" class="tag editable">
                {{ tag }}<button @click="removeTag(i)">✕</button>
              </span>
              <input v-model="tagInput" class="input-sm tag-input" placeholder="输入后回车添加" @keyup.enter="addTag" style="width:140px" />
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-sm" @click="showEdit = false">取消</button>
          <button class="btn-sm btn-primary" @click="saveQuestion" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- Import Modal -->
    <div v-if="showImport" class="modal-backdrop" @click.self="showImport = false">
      <div class="modal">
        <div class="modal-header">
          <h3>批量导入题目</h3>
          <button class="close-btn" @click="showImport = false">✕</button>
        </div>
        <div class="modal-body">
          <p class="hint-text">粘贴 JSON 数组，每个元素格式：</p>
          <pre class="code-hint">{"type":"single","content":"题目","options":["A.","B.","C.","D."],"answer":"A","explanation":"解析","knowledge_tags":["架构设计"],"difficulty":3}</pre>
          <textarea v-model="importText" class="textarea" rows="10" placeholder='[{"type":"single","content":"…"}]'></textarea>
          <p v-if="importError" class="error-text">{{ importError }}</p>
          <p v-if="importSuccess" class="success-text">{{ importSuccess }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn-sm" @click="showImport = false">关闭</button>
          <button class="btn-sm btn-primary" @click="doImport" :disabled="importLoading || !importText.trim()">
            {{ importLoading ? '导入中…' : '确认导入' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qview { display: flex; flex-direction: column; gap: 16px; height: 100%; }

.stat-row { display: flex; gap: 12px; }
.stat-card { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 8px; padding: 12px 20px; min-width: 100px; text-align: center; }
.stat-val { font-size: 24px; font-weight: 700; color: var(--c-brand); }
.stat-label { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }

.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.search-wrap { display: flex; gap: 6px; align-items: center; flex: 1; }
.search-input { flex: 1; max-width: 280px; background: var(--c-panel); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 6px 10px; font-size: 13px; }
.filter-wrap { display: flex; gap: 8px; align-items: center; }
.btn-group { display: flex; gap: 6px; margin-left: auto; }
.fav-toggle { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--c-text-2); cursor: pointer; }

.select-sm { background: var(--c-panel); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 5px 8px; font-size: 13px; }
.btn-sm { background: var(--c-border); border: none; border-radius: 6px; color: var(--c-text); padding: 6px 12px; font-size: 13px; cursor: pointer; }
.btn-sm:hover:not(:disabled) { background: var(--c-border-2); }
.btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: #1d4ed8 !important; }
.btn-primary:hover:not(:disabled) { background: #2563eb !important; }

.table-wrap { flex: 1; overflow: auto; background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 8px; }
.q-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.q-table th { position: sticky; top: 0; background: var(--c-bg); padding: 10px 12px; text-align: left; color: var(--c-text-2); font-weight: 600; border-bottom: 1px solid var(--c-border); }
.q-table td { padding: 10px 12px; border-bottom: 1px solid var(--c-panel); color: var(--c-text); vertical-align: middle; }
.q-table tr:hover td { background: #1a2740; }

.type-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.type-badge.single { background: #1e3a5f; color: var(--c-brand); }
.type-badge.multiple { background: var(--c-ok-bg); color: #4ade80; }
.type-badge.case { background: var(--c-warn-bg); color: #fb923c; }
.type-badge.essay { background: #3b0764; color: #c084fc; }
.content-cell { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-cell { color: #f59e0b; font-size: 11px; }
.tag { display: inline-block; background: #1e3a5f; color: #93c5fd; border-radius: 4px; padding: 1px 6px; font-size: 11px; margin: 2px; }

.action-btns { display: flex; gap: 4px; }
.icon-btn { background: none; border: 1px solid var(--c-border-2); border-radius: 4px; color: var(--c-text-2); width: 26px; height: 26px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 13px; }
.icon-btn:hover { border-color: var(--c-text-2); color: var(--c-text); }
.icon-btn.fav-on { color: #fbbf24; border-color: #fbbf24; }
.icon-btn.danger:hover { border-color: #f87171; color: #f87171; }

.pagination { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--c-text-2); }
.loading-tip, .empty-tip { text-align: center; padding: 48px; color: var(--c-border-2); }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 12px; width: 600px; max-height: 80vh; display: flex; flex-direction: column; }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--c-border); }
.modal-header h3 { font-size: 16px; font-weight: 700; color: var(--c-text); }
.close-btn { background: none; border: none; color: var(--c-text-2); font-size: 18px; cursor: pointer; }
.modal-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--c-border); }
.form-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.form-row.col { flex-direction: column; align-items: flex-start; }
.form-row label { font-size: 13px; color: var(--c-text-2); min-width: 60px; }
.textarea { width: 100%; background: var(--c-bg); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 8px 10px; font-size: 13px; resize: vertical; font-family: inherit; }
.input-sm { background: var(--c-bg); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 5px 8px; font-size: 13px; }
.option-row { display: flex; gap: 6px; align-items: center; width: 100%; }
.option-row .input-sm { flex: 1; }
.tags-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.tag.editable button { background: none; border: none; color: #93c5fd; cursor: pointer; margin-left: 4px; }
.tag-input { min-width: 120px; }
.hint-text { font-size: 12px; color: var(--c-text-2); }
.code-hint { background: var(--c-bg); border-radius: 6px; padding: 8px; font-size: 11px; color: #86efac; overflow-x: auto; margin: 4px 0; white-space: pre-wrap; word-break: break-all; }
.error-text { color: #f87171; font-size: 13px; }
.success-text { color: #4ade80; font-size: 13px; }
</style>
