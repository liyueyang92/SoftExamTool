<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import {
  useQuestionStore,
  type Question,
  type QuestionDraft,
  type QuestionGroup,
  type QuestionGroupDraft,
} from '../stores/question'
import { toIpcPayload } from '../utils/ipc'
import ImageInsert from '../components/ImageInsert.vue'

const store = useQuestionStore()

const searchQ = ref('')
const searching = ref(false)
const searchResults = ref<Question[]>([])
const showEdit = ref(false)
const showImport = ref(false)
const showExport = ref(false)
const showGroupEdit = ref(false)
const showGroupManage = ref(false)
const groupQuestionCounts = ref<Record<string, number>>({})
const moveTargets = ref<Record<string, string>>({})
const manageMessage = ref('')
const manageError = ref('')
const manageLoading = ref(false)
const syncing = ref(false)
const editTarget = ref<Partial<Question> | null>(null)
const editGroupOptions = ref<QuestionGroup[]>([])
const editGroupsLoading = ref(false)
const groupEdit = ref<QuestionGroupDraft>({ name: '', group_type: 'custom' })
const importText = ref('')
const importError = ref('')
const importSuccess = ref('')
const saving = ref(false)
const importLoading = ref(false)
const importGroupMode = ref<'none' | 'existing' | 'new'>('none')
const importTargetGroupId = ref('')
const importNewGroup = ref<QuestionGroupDraft>({ name: '', group_type: 'manual_import', description: '' })
const importFileLoading = ref(false)

// Export state
const exportLoading = ref(false)
const exportScope = ref<'all' | 'filtered'>('all')
const exportMessage = ref('')
const exportError = ref('')

// Pending images for new questions (not yet saved)
const pendingImages = ref<Array<{ field_name: string; source_path: string }>>([])

// Batch selection
const selectedIds = ref<Set<string>>(new Set())
const batchDeleting = ref(false)

const allSelected = computed(() => {
  const list = displayList.value
  return list.length > 0 && list.every(q => selectedIds.value.has(q.id))
})
const anySelected = computed(() => selectedIds.value.size > 0)

// ─── Auto-tagging ────────────────────────────────────────────────────────
const autoTagLoading = ref(false)
const autoTagResult = ref<
  | ({
      total: number
      auto_tagged: number
      ai_tagged?: number
      keyword_tagged?: number
      fts_tagged?: number
      inherited_count?: number
      needs_ai: number
      none_tagged: number
    } & Record<string, unknown>)
  | null
>(null)

async function autoTagSelected() {
  const ids = selectedIds.value.size > 0
    ? selectedIds.value
    : new Set(displayList.value.map(q => q.id))
  const questions = displayList.value.filter(q => ids.has(q.id))
  if (!questions.length) return

  // 跳过已有标签的题目
  const questionsToTag = questions.filter(q => !(q.knowledge_tags?.length > 0))
  const skippedCount = questions.length - questionsToTag.length
  if (skippedCount > 0) {
    console.log(`Auto-tag: skipped ${skippedCount} questions with existing tags`)
  }
  if (!questionsToTag.length) {
    autoTagResult.value = {
      total: questions.length,
      auto_tagged: 0,
      ai_tagged: 0,
      keyword_tagged: 0,
      fts_tagged: 0,
      inherited_count: 0,
      needs_ai: 0,
      none_tagged: 0,
    }
    return
  }

  // 按 question_set_id 分组：同组已有标签的优先继承
  const setKnownTags = new Map<string, string[]>()
  for (const q of questions) {
    if (q.question_set_id && q.knowledge_tags?.length) {
      setKnownTags.set(q.question_set_id, [...q.knowledge_tags])
    }
  }
  const toInherit: Question[] = []
  const toClassify: Question[] = []
  for (const q of questionsToTag) {
    if (q.question_set_id && setKnownTags.has(q.question_set_id)) {
      toInherit.push(q)
    } else {
      toClassify.push(q)
    }
  }

  autoTagLoading.value = true
  autoTagResult.value = null
  try {
    // 构造继承结果（直接应用，不走 AI）
    const inheritedResults = toInherit.map(q => ({
      question_id: q.id,
      knowledge_tags: [...(setKnownTags.get(q.question_set_id!) ?? [])],
      confidence: [1.0],
      source: 'question_set_sync',
      reasoning: '',
    }))

    let classifiedResults: Array<Record<string, unknown>> = []
    if (toClassify.length > 0) {
      const res = await window.electronAPI.autoTagQuestions(toIpcPayload({
        questions: toClassify.map(q => ({
          id: q.id,
          type: q.type,
          content: q.content,
          options: q.options ?? [],
          answer: q.answer ?? '',
          explanation: q.explanation ?? '',
          content_hash: q.content_hash ?? '',
          question_set_id: q.question_set_id ?? '',
        })),
        minConfidence: 0.0,
      }))
      if (!(res as unknown as { success: boolean }).success) {
        console.error('Auto-tag failed:', (res as unknown as { error: { message: string } }).error)
        return
      }
      const data = (res as unknown as { data: Record<string, unknown> }).data
      classifiedResults = (data.results as Array<Record<string, unknown>>) ?? []
    }

    // 统一应用所有有标签的结果（继承 / FTS / AI / 关键词兜底）
    const toApply = [
      ...inheritedResults,
      ...classifiedResults
        .filter(r => r.knowledge_tags && (r.knowledge_tags as string[]).length > 0)
        .map(r => ({
          question_id: r.question_id as string,
          knowledge_tags: r.knowledge_tags as string[],
          confidence: r.confidence as number[],
          source: (r.source as string) ?? 'fts_document',
          reasoning: (r.reasoning as string) ?? '',
        })),
    ]
    console.log(`Auto-tag: ${toClassify.length} classified, ${toInherit.length} inherited, ${toApply.length} to apply`)

    let applied = { updated: 0, history_count: 0, synced_count: 0 }
    if (toApply.length > 0) {
      const applyRes = await window.electronAPI.applyAutoTags({
        results: toApply as unknown as Array<{
          question_id: string; knowledge_tags: string[]; confidence: number[]; source: string; reasoning?: string
        }>,
      })
      if ((applyRes as unknown as { success: boolean }).success) {
        applied = (applyRes as unknown as { data: { updated: number; history_count: number; synced_count: number } }).data
        console.log(`Auto-tag applied: ${applied.updated} questions, history: ${applied.history_count}, synced: ${applied.synced_count}`)
      } else {
        const err = (applyRes as unknown as { error: { message: string } }).error
        console.error('Auto-tag apply failed:', err.message)
      }
    }

    // 前端统计（继承 + 分类）
    const classifiedTagged = classifiedResults.filter(r => (r.knowledge_tags as string[])?.length > 0)
    const aiTagged = classifiedTagged.filter(r => r.source === 'ai_classifier').length
    const keywordTagged = classifiedTagged.filter(r => r.source === 'keyword_fallback').length
    const ftsTagged = classifiedTagged.filter(r => r.source === 'fts_document').length
    autoTagResult.value = {
      total: questionsToTag.length,
      auto_tagged: classifiedTagged.length + toInherit.length + (applied.synced_count ?? 0),
      ai_tagged: aiTagged,
      keyword_tagged: keywordTagged,
      fts_tagged: ftsTagged,
      inherited_count: toInherit.length,
      needs_ai: 0,
      none_tagged: toClassify.length - classifiedTagged.length,
    }

    // Refresh list (and current search results if any)
    if (searchQ.value.trim()) {
      await doSearch()
    } else {
      await store.fetchPage()
    }
    console.log('Auto-tag: after refresh, first question tags:', displayList.value[0]?.knowledge_tags)
  } catch (e) {
    console.error('Auto-tag error:', e)
  } finally {
    autoTagLoading.value = false
  }
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set()
  } else {
    selectedIds.value = new Set(displayList.value.map(q => q.id))
  }
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}

async function batchDelete() {
  const count = selectedIds.value.size
  if (!count) return
  if (!confirm(`确认删除选中的 ${count} 道题目？删除后可通过爬虫重新获取。`)) return
  batchDeleting.value = true
  try {
    await store.batchRemove(Array.from(selectedIds.value))
    selectedIds.value = new Set()
  } finally {
    batchDeleting.value = false
  }
}

const typeLabels: Record<string, string> = { single: '单选', multiple: '多选', case: '案例', essay: '论文' }
const diffLabel = (d: number) => ['', '★☆☆☆☆', '★★☆☆☆', '★★★☆☆', '★★★★☆', '★★★★★'][d] ?? d

const displayList = computed(() => searchQ.value.trim() ? searchResults.value : store.questions)
const recentExamYears = computed(() => {
  const year = new Date().getFullYear()
  return Array.from({ length: 5 }, (_, i) => year - i)
})
const setCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const question of displayList.value) {
    if (!question.question_set_id) continue
    counts.set(question.question_set_id, (counts.get(question.question_set_id) ?? 0) + 1)
  }
  return counts
})

const dedupedGroups = computed(() => {
  const seen = new Map<string, QuestionGroup>()
  for (const g of store.groups) {
    if (!seen.has(g.name)) seen.set(g.name, g)
  }
  return Array.from(seen.values())
})

onMounted(async () => {
  await Promise.all([store.fetchPage(), store.loadStats(), store.fetchGroups()])
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

function clearSearch() { searchQ.value = ''; searchResults.value = []; selectedIds.value = new Set() }

async function applyFilter(f: Record<string, unknown>) {
  store.setFilter(f)
  selectedIds.value = new Set()
  await store.fetchPage()
}

async function loadEditGroupOptions() {
  editGroupsLoading.value = true
  editGroupOptions.value = [...store.groups]
  try {
    const res = await window.electronAPI.listQuestionGroups()
    if (res.success) {
      editGroupOptions.value = res.data as QuestionGroup[]
    } else {
      await store.fetchGroups()
      editGroupOptions.value = [...store.groups]
    }
  } finally {
    editGroupsLoading.value = false
  }
}

async function openNew() {
  await loadEditGroupOptions()
  editTarget.value = { group_id: null, type: 'single', content: '', options: ['A. ', 'B. ', 'C. ', 'D. '], answer: 'A', explanation: '', knowledge_tags: [], difficulty: 3, source_type: 'manual' }
  showEdit.value = true
}

async function openEdit(q: Question) {
  await loadEditGroupOptions()
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
      const saved = await store.insert(editTarget.value as QuestionDraft)
      if (saved && pendingImages.value.length > 0) {
        // Process pending images for newly created question
        const questionId = saved.id
        for (const pending of pendingImages.value) {
          try {
            const result = await window.electronAPI.uploadQuestionImage({
              question_id: questionId,
              field_name: pending.field_name as 'content' | 'options' | 'explanation',
              source_path: pending.source_path,
            })
            if (!result.success) continue
            const imgTag = `<img src="exam-image://${result.data.imageId}" alt="" />`
            // Replace placeholder in the corresponding field
            const placeholder = `<!-- pending-image:${pending.source_path} -->`
            if (pending.field_name === 'content') {
              editTarget.value.content = (editTarget.value.content || '').replace(placeholder, imgTag)
            } else if (pending.field_name === 'explanation') {
              editTarget.value.explanation = (editTarget.value.explanation || '').replace(placeholder, imgTag)
            }
          } catch (e) {
            console.error('[saveQuestion] pending image upload failed:', e)
          }
        }
        // Update question with actual image references
        await store.update(questionId, editTarget.value)
        pendingImages.value = []
      }
      if (saved) editTarget.value.id = saved.id
    }
    showEdit.value = false
  } finally {
    saving.value = false
  }
}

function onInsertToField(field: 'content' | 'options' | 'explanation', html: string) {
  if (!editTarget.value) return
  if (html.startsWith('<!-- pending-image:')) {
    const sourcePath = html.slice('<!-- pending-image:'.length, -4)
    pendingImages.value.push({ field_name: field, source_path: sourcePath })
  }
  if (field === 'content') {
    editTarget.value.content = (editTarget.value.content || '') + html
  } else if (field === 'explanation') {
    editTarget.value.explanation = (editTarget.value.explanation || '') + html
  }
}

function stripHtml(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
}

function openNewGroup() {
  groupEdit.value = { name: '', group_type: 'custom', exam_year: null, exam_period: null, description: '' }
  showGroupEdit.value = true
}

async function saveGroup() {
  if (!groupEdit.value.name.trim()) return
  await store.saveGroup(groupEdit.value)
  showGroupEdit.value = false
}

function groupTypeLabel(t: string) {
  const labels: Record<string, string> = {
    custom: '自定义', past_exam: '历年真题', ai_generated: 'AI出题',
    crawled: '爬虫导入', manual_import: '批量导入',
  }
  return labels[t] ?? t
}

async function refreshGroupCounts() {
  await store.fetchGroups()
  const counts: Record<string, number> = {}
  for (const g of store.groups) {
    try {
      const res = await window.electronAPI.countQuestionsInGroup(g.id)
      counts[g.id] = res.success ? (res.data as number) : 0
    } catch {
      counts[g.id] = 0
    }
  }
  groupQuestionCounts.value = counts
}

async function openGroupManage() {
  manageMessage.value = ''
  manageError.value = ''
  manageLoading.value = true
  moveTargets.value = {}
  await refreshGroupCounts()
  manageLoading.value = false
  showGroupManage.value = true
}

async function syncGroupMeta() {
  manageMessage.value = ''
  manageError.value = ''
  syncing.value = true
  try {
    const res = await window.electronAPI.syncGroupExamMeta()
    if (res.success) {
      const result = res.data as { updated: number; merged: number }
      const parts: string[] = []
      if (result.updated > 0) parts.push(`${result.updated} 个分组更新了元数据`)
      if (result.merged > 0) parts.push(`${result.merged} 个重复分组已合并`)
      manageMessage.value = parts.length ? parts.join('，') : '所有分组元数据已是最新，无重复'
      await refreshGroupCounts()
    } else {
      manageError.value = (res.error as { message: string })?.message || '同步失败'
    }
  } catch (e) {
    manageError.value = (e as Error).message
  } finally {
    syncing.value = false
  }
}

async function deleteGroup(id: string) {
  const g = store.groups.find((x) => x.id === id)
  if (!confirm(`确认删除分组「${g?.name || id}」？此操作不可撤销。`)) return
  manageMessage.value = ''
  manageError.value = ''
  try {
    await store.removeGroup(id)
    const newCounts = { ...groupQuestionCounts.value }
    delete newCounts[id]
    groupQuestionCounts.value = newCounts
    manageMessage.value = '分组已删除'
  } catch (e) {
    manageError.value = (e as Error).message
  }
}

async function moveGroup(fromId: string) {
  const toId = moveTargets.value[fromId]
  if (!toId) { manageError.value = '请选择目标分组'; return }
  const fromGroup = store.groups.find((g) => g.id === fromId)
  const toGroup = store.groups.find((g) => g.id === toId)
  const count = groupQuestionCounts.value[fromId] || 0
  if (!confirm(`确认将「${fromGroup?.name || fromId}」中的 ${count} 道题目移动到「${toGroup?.name || toId}」？`)) return
  manageMessage.value = ''
  manageError.value = ''
  try {
    const moved = await store.moveQuestions(fromId, toId)
    groupQuestionCounts.value[fromId] = Math.max(0, (groupQuestionCounts.value[fromId] || 0) - moved)
    groupQuestionCounts.value[toId] = (groupQuestionCounts.value[toId] || 0) + moved
    moveTargets.value[fromId] = ''
    manageMessage.value = `已移动 ${moved} 道题目`
  } catch (e) {
    manageError.value = (e as Error).message
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
    const groupId = await store.ensureGroupId({
      groupId: importGroupMode.value === 'existing' ? (importTargetGroupId.value || null) : null,
      newGroup: importGroupMode.value === 'new' && importNewGroup.value.name.trim() ? importNewGroup.value : null,
    })
    const normalized = data.map((item) => {
      if (typeof item === 'object' && item !== null) {
        return {
          group_id: groupId,
          source_type: 'imported',
          ...(item as Record<string, unknown>),
        }
      }
      return item
    })
    const count = await store.batchImport(normalized)
    importSuccess.value = `成功导入 ${count} 道题`
    importText.value = ''
  } catch (e) {
    importError.value = String(e)
  } finally {
    importLoading.value = false
  }
}

async function doImportFile() {
  importError.value = ''; importSuccess.value = ''
  importFileLoading.value = true
  try {
    const result = await store.importFile({
      groupId: importGroupMode.value === 'existing' ? (importTargetGroupId.value || null) : null,
      newGroup: importGroupMode.value === 'new' && importNewGroup.value.name.trim() ? importNewGroup.value : null,
    })
    const imgInfo = result.imageCount ? `，含 ${result.imageCount} 张图片` : ''
    importSuccess.value = `成功从文件导入 ${result.count} 道题${imgInfo}`
  } catch (e) {
    importError.value = String(e)
  } finally {
    importFileLoading.value = false
  }
}

async function openExport() {
  exportMessage.value = ''; exportError.value = ''
  exportScope.value = 'all'
  showExport.value = true
}

async function doExport() {
  exportMessage.value = ''; exportError.value = ''
  exportLoading.value = true
  try {
    const exportFilter = exportScope.value === 'filtered' ? { ...store.filter } : {}
    // Remove page/pageSize from filter for export
    delete exportFilter.page; delete exportFilter.pageSize
    const result = await store.exportData(exportFilter)
    if (result) {
      const imgInfo = result.imageCount ? `，含 ${result.imageCount} 张图片` : ''
      exportMessage.value = `成功导出 ${result.count} 道题目${imgInfo}到 ${result.filePath}`
    }
  } catch (e) {
    exportError.value = String(e)
  } finally {
    exportLoading.value = false
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

function setLabel(q: Question): string {
  if (!q.question_set_id) return ''
  const total = setCounts.value.get(q.question_set_id) ?? 0
  return total > 1 ? `关联 ${q.question_set_order || 1}/${total}` : '关联题'
}
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
        <select class="select-sm" @change="applyFilter({ group_name: ($event.target as HTMLSelectElement).value || undefined, page: 1 })">
          <option value="">全部分组</option>
          <option v-for="g in dedupedGroups" :key="g.name" :value="g.name">{{ g.name }}</option>
        </select>
        <select class="select-sm" @change="applyFilter({ source_type: ($event.target as HTMLSelectElement).value || undefined, page: 1 })">
          <option value="">全部来源</option>
          <option value="manual">手动录入</option>
          <option value="ai_generated">AI 出题</option>
          <option value="crawled">爬虫导入</option>
          <option value="imported">批量导入</option>
        </select>
        <select class="select-sm" @change="applyFilter({ exam_year: Number(($event.target as HTMLSelectElement).value) || undefined, page: 1 })">
          <option value="">真题年份</option>
          <option v-for="year in recentExamYears" :key="year" :value="year">{{ year }}</option>
        </select>
        <select class="select-sm" @change="applyFilter({ exam_period: (($event.target as HTMLSelectElement).value || undefined) as 'H1' | 'H2' | undefined, page: 1 })">
          <option value="">全部期次</option>
          <option value="H1">上半年</option>
          <option value="H2">下半年</option>
        </select>
        <select class="select-sm" @change="applyFilter({ type: ($event.target as HTMLSelectElement).value || undefined, page: 1 })">
          <option value="">全部题型</option>
          <option v-for="(label, val) in typeLabels" :key="val" :value="val">{{ label }}</option>
        </select>
        <select class="select-sm" @change="applyFilter({ difficulty: Number(($event.target as HTMLSelectElement).value) || undefined, page: 1 })">
          <option value="">全部难度</option>
          <option v-for="d in [1,2,3,4,5]" :key="d" :value="d">{{ diffLabel(d) }}</option>
        </select>
        <select class="select-sm" @change="applyFilter({ has_knowledge_tags: ($event.target as HTMLSelectElement).value === '' ? undefined : ($event.target as HTMLSelectElement).value === 'true', page: 1 })">
          <option value="">全部知识点</option>
          <option value="true">有知识点</option>
          <option value="false">无知识点</option>
        </select>
        <label class="fav-toggle">
          <input type="checkbox" @change="applyFilter({ has_images: ($event.target as HTMLInputElement).checked || undefined, page: 1 })" />
          含图片
        </label>
        <label class="fav-toggle">
          <input type="checkbox" @change="applyFilter({ has_img_tags: ($event.target as HTMLInputElement).checked || undefined, page: 1 })" />
          &lt;img&gt;标签
        </label>
        <label class="fav-toggle">
          <input type="checkbox" @change="applyFilter({ is_favorite: ($event.target as HTMLInputElement).checked || undefined, page: 1 })" />
          仅收藏
        </label>
      </div>

      <div class="btn-group">
        <button class="btn-sm btn-primary" @click="openNew">+ 新建题目</button>
        <button class="btn-sm" @click="openNewGroup">+ 新建分组</button>
        <button class="btn-sm" @click="openGroupManage">管理分组</button>
        <button class="btn-sm" @click="showImport = true">批量导入</button>
        <button class="btn-sm" @click="openExport">导出题目</button>
        <button v-if="anySelected" class="btn-sm btn-danger" @click="batchDelete" :disabled="batchDeleting">
          {{ batchDeleting ? '删除中…' : `���量删除 (${selectedIds.size})` }}
        </button>
        <button class="btn-sm btn-accent" @click="autoTagSelected" :disabled="autoTagLoading">
          {{ autoTagLoading ? '标注中…' : '🤖 智能补全知识点' }}
        </button>
        <span v-if="autoTagResult" class="autotag-result">
          已标注 {{ autoTagResult.auto_tagged }}/{{ autoTagResult.total }}
          <template v-if="(autoTagResult.ai_tagged ?? 0) > 0 || (autoTagResult.keyword_tagged ?? 0) > 0 || (autoTagResult.fts_tagged ?? 0) > 0 || (autoTagResult.inherited_count ?? 0) > 0 || autoTagResult.none_tagged > 0">
            （
            <span v-if="(autoTagResult.ai_tagged ?? 0) > 0">AI: {{ autoTagResult.ai_tagged }}</span>
            <span v-if="(autoTagResult.keyword_tagged ?? 0) > 0">
              <span v-if="(autoTagResult.ai_tagged ?? 0) > 0">, </span>关键词: {{ autoTagResult.keyword_tagged }}
            </span>
            <span v-if="(autoTagResult.fts_tagged ?? 0) > 0">
              <span v-if="(autoTagResult.ai_tagged ?? 0) + (autoTagResult.keyword_tagged ?? 0) > 0">, </span>FTS: {{ autoTagResult.fts_tagged }}
            </span>
            <span v-if="(autoTagResult.inherited_count ?? 0) > 0">
              <span v-if="(autoTagResult.ai_tagged ?? 0) + (autoTagResult.keyword_tagged ?? 0) + (autoTagResult.fts_tagged ?? 0) > 0">, </span>继承: {{ autoTagResult.inherited_count }}</span>
            <span v-if="autoTagResult.none_tagged > 0">
              <span v-if="(autoTagResult.ai_tagged ?? 0) + (autoTagResult.keyword_tagged ?? 0) + (autoTagResult.fts_tagged ?? 0) + (autoTagResult.inherited_count ?? 0) > 0">, </span>未匹配: {{ autoTagResult.none_tagged }}
            </span>
            ）
          </template>
        </span>
      </div>
    </div>

    <!-- Table -->
    <div class="table-wrap">
      <div v-if="store.loading" class="loading-tip">加载中…</div>
      <div v-else-if="displayList.length === 0" class="empty-tip">暂无题目</div>
      <table v-else class="q-table">
        <thead>
          <tr>
            <th style="width:36px"><input type="checkbox" :checked="allSelected" @change="toggleSelectAll" title="全选/取消" /></th>
            <th style="width:50px">题型</th>
            <th>题目</th>
            <th style="width:150px">分组</th>
            <th style="width:80px">难度</th>
            <th style="width:120px">知识点</th>
            <th style="width:100px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="q in displayList" :key="q.id" :class="{ 'row-selected': selectedIds.has(q.id) }">
            <td><input type="checkbox" :checked="selectedIds.has(q.id)" @change="toggleSelect(q.id)" /></td>
            <td><span class="type-badge" :class="q.type">{{ typeLabels[q.type] }}</span></td>
            <td class="content-cell">
              <span v-if="setLabel(q)" class="set-badge">{{ setLabel(q) }}</span>
              {{ stripHtml(q.content).slice(0, 80) }}{{ stripHtml(q.content).length > 80 ? '…' : '' }}
            </td>
            <td>
              <div>{{ q.group_name || '未分组' }}</div>
              <div v-if="q.exam_year" class="mini-meta">{{ q.exam_year }} {{ q.exam_period === 'H1' ? '上半年' : '下半年' }}</div>
            </td>
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
            <label style="margin-left:12px">分组</label>
            <select v-model="editTarget.group_id" class="select-sm">
              <option :value="null">未分组</option>
              <option v-if="editGroupsLoading" disabled value="">分组加载中...</option>
              <option v-for="g in editGroupOptions" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
            <label style="margin-left:12px">难度</label>
            <select v-model="editTarget.difficulty" class="select-sm">
              <option v-for="d in [1,2,3,4,5]" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>

          <div class="form-row col">
            <label>题目内容 *</label>
            <div class="field-with-image">
              <textarea v-model="editTarget.content" class="textarea flex-1" rows="4" placeholder="题目正文…"></textarea>
              <ImageInsert :question-id="editTarget?.id || null" field-name="content" @insert="(html) => onInsertToField('content', html)" />
            </div>
          </div>

          <div v-if="editTarget.type === 'single' || editTarget.type === 'multiple'" class="form-row col">
            <label>选项</label>
            <div v-for="(_opt, i) in editTarget.options" :key="i" class="option-row">
              <input v-model="editTarget.options![i]" class="input-sm" placeholder="选项内容" />
              <ImageInsert :question-id="editTarget?.id || null" field-name="options" @insert="(html) => { if (editTarget?.options) editTarget.options[i] = (editTarget.options[i] || '') + html }" />
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
            <div class="field-with-image">
              <textarea v-model="editTarget.explanation" class="textarea flex-1" rows="3" placeholder="答题解析（可选）"></textarea>
              <ImageInsert :question-id="editTarget?.id || null" field-name="explanation" @insert="(html) => onInsertToField('explanation', html)" />
            </div>
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

    <!-- Group Modal -->
    <div v-if="showGroupEdit" class="modal-backdrop" @click.self="showGroupEdit = false">
      <div class="modal" style="width:520px">
        <div class="modal-header">
          <h3>新建题库分组</h3>
          <button class="close-btn" @click="showGroupEdit = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-row col">
            <label>分组名称 *</label>
            <input v-model="groupEdit.name" class="input-sm" placeholder="如：2025上半年真题" />
          </div>
          <div class="form-row">
            <label>分组类型</label>
            <select v-model="groupEdit.group_type" class="select-sm">
              <option value="custom">自定义</option>
              <option value="past_exam">历年真题</option>
              <option value="ai_generated">AI 出题</option>
              <option value="crawled">爬虫导入</option>
              <option value="manual_import">批量导入</option>
            </select>
          </div>
          <div v-if="groupEdit.group_type === 'past_exam'" class="form-row">
            <label>真题年份</label>
            <select v-model="groupEdit.exam_year" class="select-sm" style="width:110px">
              <option :value="null">请选择</option>
              <option v-for="year in recentExamYears" :key="year" :value="year">{{ year }}年</option>
            </select>
            <label style="min-width:auto">期次</label>
            <select v-model="groupEdit.exam_period" class="select-sm" style="width:110px">
              <option :value="null">请选择</option>
              <option value="H1">上半年</option>
              <option value="H2">下半年</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-sm" @click="showGroupEdit = false">取消</button>
          <button class="btn-sm btn-primary" @click="saveGroup">保存</button>
        </div>
      </div>
    </div>

    <!-- Group Manage Modal -->
    <div v-if="showGroupManage" class="modal-backdrop" @click.self="showGroupManage = false">
      <div class="modal" style="width:800px">
        <div class="modal-header">
          <h3>管理分组</h3>
          <button class="btn-sm" style="margin-right:8px" @click="syncGroupMeta" :disabled="syncing">{{ syncing ? '同步中…' : '同步元数据' }}</button>
          <button class="close-btn" @click="showGroupManage = false">✕</button>
        </div>
        <div class="modal-body">
          <div v-if="manageLoading" class="loading-tip">加载中…</div>
          <div v-else-if="!store.groups.length" class="empty-tip">暂无分组</div>
          <table v-else class="group-table">
            <thead>
              <tr>
                <th style="width:160px">分组名称</th>
                <th style="width:80px">类型</th>
                <th style="width:80px">真题年份</th>
                <th style="width:70px">期次</th>
                <th style="width:60px">题目数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in store.groups" :key="g.id">
                <td class="group-name-cell">
                  <strong>{{ g.name }}</strong>
                </td>
                <td><span class="type-pill-sm">{{ groupTypeLabel(g.group_type) }}</span></td>
                <td class="count-cell">{{ g.exam_year ?? '-' }}</td>
                <td class="count-cell">{{ g.exam_period ? (g.exam_period === 'H1' ? '上半年' : '下半年') : '-' }}</td>
                <td class="count-cell">{{ groupQuestionCounts[g.id] ?? '…' }}</td>
                <td>
                  <div class="group-actions">
                    <button
                      class="btn-sm danger-btn"
                      :disabled="(groupQuestionCounts[g.id] ?? 0) > 0"
                      @click="deleteGroup(g.id)"
                      :title="(groupQuestionCounts[g.id] ?? 0) > 0 ? '分组非空，无法删除' : '删除空分组'"
                    >删除</button>
                    <template v-if="(groupQuestionCounts[g.id] ?? 0) > 0">
                      <select
                        v-model="moveTargets[g.id]"
                        class="select-sm move-select"
                      >
                        <option value="">移动到…</option>
                        <option v-for="dest in dedupedGroups.filter(x => x.id !== g.id)" :key="dest.id" :value="dest.id">
                          {{ dest.name }}
                        </option>
                      </select>
                      <button
                        class="btn-sm"
                        :disabled="!moveTargets[g.id]"
                        @click="moveGroup(g.id)"
                      >移动</button>
                    </template>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="manageMessage" class="success-text">{{ manageMessage }}</p>
          <p v-if="manageError" class="error-text">{{ manageError }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn-sm" @click="showGroupManage = false">关闭</button>
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
          <div class="form-row col">
            <label>导入分组</label>
            <div class="type-checks">
              <label class="check-label"><input type="radio" value="none" v-model="importGroupMode" /> 不指定</label>
              <label class="check-label"><input type="radio" value="existing" v-model="importGroupMode" /> 现有分组</label>
              <label class="check-label"><input type="radio" value="new" v-model="importGroupMode" /> 新建分组</label>
            </div>
          </div>
          <div v-if="importGroupMode === 'existing'" class="form-row">
            <select v-model="importTargetGroupId" class="select-sm">
              <option value="">请选择分组</option>
              <option v-for="g in dedupedGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </div>
          <div v-if="importGroupMode === 'new'" class="form-row col">
            <input v-model="importNewGroup.name" class="input-sm" placeholder="新分组名称" />
            <div class="form-row">
              <label>分组类型</label>
              <select v-model="importNewGroup.group_type" class="select-sm">
                <option value="manual_import">批量导入</option>
                <option value="past_exam">历年真题</option>
                <option value="custom">自定义</option>
              </select>
            </div>
            <div v-if="importNewGroup.group_type === 'past_exam'" class="form-row" style="margin-top:4px">
              <label>真题年份</label>
              <select v-model="importNewGroup.exam_year" class="select-sm" style="width:110px">
                <option :value="null">请选择</option>
                <option v-for="year in recentExamYears" :key="year" :value="year">{{ year }}年</option>
              </select>
              <label style="min-width:auto">期次</label>
              <select v-model="importNewGroup.exam_period" class="select-sm" style="width:110px">
                <option :value="null">请选择</option>
                <option value="H1">上半年</option>
                <option value="H2">下半年</option>
              </select>
            </div>
          </div>
          <textarea v-model="importText" class="textarea" rows="10" placeholder='[{"type":"single","content":"…"}]'></textarea>
          <div class="form-row" style="justify-content:space-between">
            <span class="hint-text">或从文件导入：</span>
            <button class="btn-sm" @click="doImportFile" :disabled="importFileLoading">
              {{ importFileLoading ? '导入中…' : '从 JSON 文件导入' }}
            </button>
          </div>
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

    <!-- Export Modal -->
    <div v-if="showExport" class="modal-backdrop" @click.self="showExport = false">
      <div class="modal" style="width:480px">
        <div class="modal-header">
          <h3>导出题目</h3>
          <button class="close-btn" @click="showExport = false">✕</button>
        </div>
        <div class="modal-body">
          <p class="hint-text">将题目导出为 JSON 文件，可用于备份或跨设备迁移。</p>
          <div class="form-row col">
            <label>导出范围</label>
            <div class="type-checks">
              <label class="check-label"><input type="radio" value="all" v-model="exportScope" /> 全部题目（{{ store.stats.total ?? '…' }} 道）</label>
              <label class="check-label"><input type="radio" value="filtered" v-model="exportScope" /> 当前筛选结果（{{ store.total }} 道）</label>
            </div>
          </div>
          <p v-if="exportMessage" class="success-text">{{ exportMessage }}</p>
          <p v-if="exportError" class="error-text">{{ exportError }}</p>
        </div>
        <div class="modal-footer">
          <button class="btn-sm" @click="showExport = false">关闭</button>
          <button class="btn-sm btn-primary" @click="doExport" :disabled="exportLoading">
            {{ exportLoading ? '导出中…' : '导出 JSON 文件' }}
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
.btn-danger { background: #b91c1c !important; color: #fff !important; }
.btn-danger:hover:not(:disabled) { background: #dc2626 !important; }
.btn-accent { background: #4338ca !important; color: #fff !important; }
.btn-accent:hover:not(:disabled) { background: #6366f1 !important; }
.autotag-result { font-size: 11px; color: #86efac; margin-left: 6px; font-weight: 600; }
.autotag-error { color: #fca5a5; display: block; font-size: 11px; margin-top: 2px; }

.table-wrap { flex: 1; overflow: auto; background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 8px; }
.q-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.q-table th { position: sticky; top: 0; background: var(--c-bg); padding: 10px 12px; text-align: left; color: var(--c-text-2); font-weight: 600; border-bottom: 1px solid var(--c-border); }
.q-table td { padding: 10px 12px; border-bottom: 1px solid var(--c-panel); color: var(--c-text); vertical-align: middle; }
.q-table tr:hover td { background: #1a2740; }
.q-table tr.row-selected td { background: #1e3a5f; }
.q-table tr.row-selected:hover td { background: #1e3a6f; }
.mini-meta { font-size: 11px; color: var(--c-text-2); margin-top: 2px; }

.type-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.set-badge { display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 999px; background: #dbeafe; color: #1d4ed8; font-size: 11px; font-weight: 700; vertical-align: 1px; }
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

.group-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.group-table th { text-align: left; padding: 8px 10px; color: var(--c-text-2); font-weight: 600; border-bottom: 1px solid var(--c-border); }
.group-table td { padding: 10px; border-bottom: 1px solid var(--c-panel); color: var(--c-text); vertical-align: middle; }
.group-table tbody tr:hover td { background: #1a2740; }
.group-name-cell { display: flex; flex-direction: column; }
.group-name-cell strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count-cell { font-weight: 700; font-variant-numeric: tabular-nums; }
.type-pill-sm { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #1e3a5f; color: #93c5fd; }
.group-actions { display: flex; gap: 6px; align-items: center; }
.move-select { min-width: 140px; }
.danger-btn { color: #f87171 !important; border-color: #f87171 !important; }
.danger-btn:hover:not(:disabled) { background: #3b1010 !important; }
.danger-btn:disabled { opacity: 0.35; cursor: not-allowed; color: var(--c-text-2) !important; border-color: var(--c-border-2) !important; }

.field-with-image { display: flex; gap: 6px; align-items: flex-start; }
.flex-1 { flex: 1; }

.type-checks { display: flex; flex-direction: column; gap: 6px; }
.check-label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text); cursor: pointer; }
.check-label input[type="radio"] { accent-color: #1d4ed8; }
</style>
