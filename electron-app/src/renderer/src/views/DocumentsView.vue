<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { PdfImportSelection } from '../../../preload/shared-types'
import { useDocumentStore, type Doc, type DocChunk } from '../stores/document'
import DocTagReview from '../components/DocTagReview.vue'

const route = useRoute()

const store = useDocumentStore()

// ─── Tag review tab ────────────────────────────────────────────────────────
const chunkPanelTab = ref<'chunks' | 'review'>('chunks')


const selectedDoc = ref<Doc | null>(null)
const chunks = ref<DocChunk[]>([])
const loadingChunks = ref(false)
const importError = ref('')
const importing = ref(false)

// 当前正被用户查看的"解析中"文档的 ID（用于订阅实时更新）
const watchingDocId = ref<string | null>(null)

const chunkSearchQuery = ref('')
const pageJumpInput = ref('')
const chunkViewError = ref('')
const expandedChunkIds = ref(new Set<string>())

// Edit mode
const editingChunkId = ref<string | null>(null)
const editContent = ref('')
const editSaving = ref(false)

const showImportModal = ref(false)
const selectedFile = ref<PdfImportSelection | null>(null)
const topMarginPercent = ref(7)
const bottomMarginPercent = ref(7)
const startPage = ref(1)
const endPageInput = ref('')
const extractTables = ref(true)
const savePageImages = ref(true)
const generateVisualSummary = ref(false)
const visionMode = ref<'disabled' | 'remote' | 'local'>('disabled')
const previewPage = ref(1)
const previewPageCount = ref<number | null>(null)
const previewText = ref('')
const previewLoading = ref(false)
const previewError = ref('')

// Reparse modal
const showReparseModal = ref(false)
const reparseTarget = ref<DocChunk | null>(null)
const reparseTopPercent = ref(7)
const reparseBottomPercent = ref(7)
const reparsing = ref(false)
const reparsePreviewText = ref('')
const reparsePreviewLoading = ref(false)
const reparsePreviewError = ref('')

let disposeTaskProgress: (() => void) | null = null
let disposeTaskPartial: (() => void) | null = null

const filteredChunks = computed(() => {
  const query = chunkSearchQuery.value.trim().toLowerCase()
  if (!query) return chunks.value
  return chunks.value.filter((chunk) => {
    const tags = chunk.knowledge_tags.join(' ').toLowerCase()
    return (
      chunk.content.toLowerCase().includes(query) ||
      tags.includes(query) ||
      String(chunk.page_num).includes(query)
    )
  })
})

const selectedDocParsePercent = computed(() => {
  if (!selectedDoc.value) return 0
  const p = store.parsingProgress[selectedDoc.value.id]
  if (!p || !p.totalPages) return 0
  return Math.min(100, Math.round((p.parsedPages.length / p.totalPages) * 100))
})

function docProgressText(docId: string): string {
  const p = store.parsingProgress[docId]
  if (!p) return '解析中…'
  const parsed = p.parsedPages.length
  const total = p.totalPages || '?'
  return `解析中 ${parsed}/${total} 页 · ${p.chunkCount} 个块`
}

function docProgressDetail(docId: string): string {
  const p = store.parsingProgress[docId]
  if (!p) return ''
  if (!p.totalPages) return '准备中…'
  const pages = [...p.parsedPages].sort((a, b) => a - b)
  if (pages.length === 0) return '尚未完成任何页面'
  const ranges: string[] = []
  let start = pages[0], end = pages[0]
  for (let i = 1; i < pages.length; i++) {
    if (pages[i] === end + 1) { end = pages[i]; continue }
    ranges.push(start === end ? `${start}` : `${start}~${end}`)
    start = pages[i]; end = pages[i]
  }
  ranges.push(start === end ? `${start}` : `${start}~${end}`)
  return `已完成页码: ${ranges.join(', ')}`
}

async function refreshDocuments() {
  await store.fetchAll()
  if (selectedDoc.value) {
    selectedDoc.value = store.documents.find((doc) => doc.id === selectedDoc.value?.id) ?? null
  }
}

function resetChunkViewState() {
  chunkSearchQuery.value = ''
  pageJumpInput.value = ''
  chunkViewError.value = ''
  expandedChunkIds.value = new Set()
  watchingDocId.value = null
}

onMounted(async () => {
  await refreshDocuments()
  // 如果从学习计划等页面跳转过来并指定了文档 ID，自动打开并跳转到指定页
  const targetId = route.query.docId as string | undefined
  const targetPage = route.query.page as string | undefined
  if (targetId) {
    await nextTick()
    await openDocById(targetId)
    if (targetPage) await jumpToPageNum(Number(targetPage))
  }

  disposeTaskProgress = window.electronAPI.onTaskProgress(async (msg) => {
    if (!store.importingTaskId || msg.taskId !== store.importingTaskId) return
    if (msg.progress >= 100) {
      store.onImportComplete()
      importing.value = false
      // 如果完成的是当前查看的文档，刷新 chunks
      if (watchingDocId.value) {
        await openDocById(watchingDocId.value)
        watchingDocId.value = null
      }
      await refreshDocuments()
    }
    if (msg.progress < 0) {
      store.importingTaskId = null
      importing.value = false
      watchingDocId.value = null
    }
  })
  disposeTaskPartial = window.electronAPI.onTaskPartial(async (data) => {
    if (!store.importingTaskId || data.taskId !== store.importingTaskId) return
    // 更新 store 中的解析进度
    const docId = store.updateParsingProgress(
      data.taskId,
      data.pageNum,
      data.totalPages,
      (data.chunks as unknown[]).length,
    )
    // 如果用户正在查看这个文档的解析进度，实时刷新 chunks
    if (docId && watchingDocId.value === docId) {
      chunks.value = await store.getChunks(docId)
      assets.value = (await store.getDocAssets(docId)) as Array<{ id: string; file_path: string; asset_type: string }>
      loadingChunks.value = false
    }
  })
})

onBeforeUnmount(() => {
  if (disposeTaskProgress) disposeTaskProgress()
  if (disposeTaskPartial) disposeTaskPartial()
})

// 当从其他页面跳转过来（已在本页）且 docId query 变化时自动切换
watch(
  () => route.query.docId,
  async (newId) => {
    if (!newId || typeof newId !== 'string') return
    if (store.documents.length === 0) await refreshDocuments()
    await openDocById(newId)
    const page = route.query.page as string | undefined
    if (page) await jumpToPageNum(Number(page))
  },
)

function resetImportState(file: PdfImportSelection | null) {
  selectedFile.value = file
  topMarginPercent.value = 7
  bottomMarginPercent.value = 7
  startPage.value = 1
  endPageInput.value = ''
  extractTables.value = true
  savePageImages.value = true
  generateVisualSummary.value = false
  visionMode.value = 'disabled'
  previewPage.value = 1
  previewPageCount.value = null
  previewText.value = ''
  previewLoading.value = false
  previewError.value = ''
  importError.value = ''
  importing.value = false
}

function buildImportOptions() {
  if (!selectedFile.value) throw new Error('请先选择 PDF 文件')

  const top = Number(topMarginPercent.value)
  const bottom = Number(bottomMarginPercent.value)
  const start = Number(startPage.value)
  const end = String(endPageInput.value).trim() === '' ? null : Number(endPageInput.value)

  if (Number.isNaN(top) || top < 0 || top >= 100) throw new Error('顶部裁剪比例需在 0 到 99 之间')
  if (Number.isNaN(bottom) || bottom < 0 || bottom >= 100) throw new Error('底部裁剪比例需在 0 到 99 之间')
  if (top + bottom >= 100) throw new Error('顶部与底部裁剪比例之和必须小于 100')
  if (!Number.isInteger(start) || start < 1) throw new Error('起始页必须大于等于 1')
  if (end !== null && (!Number.isInteger(end) || end < start)) throw new Error('结束页必须大于等于起始页')

  return {
    filePath: selectedFile.value.filePath,
    topMarginRatio: top / 100,
    bottomMarginRatio: bottom / 100,
    startPage: start,
    endPage: end,
    extractTables: extractTables.value,
    savePageImages: savePageImages.value,
    generateVisualSummary: generateVisualSummary.value,
    visionMode: generateVisualSummary.value ? visionMode.value : 'disabled',
  }
}

async function openImportModal() {
  const file = await store.pickImportFile()
  if (!file) return
  resetImportState(file)
  showImportModal.value = true
  await loadPreview()
}

async function loadPreview() {
  previewError.value = ''
  previewLoading.value = true

  try {
    const options = buildImportOptions()
    const page = Number(previewPage.value)
    if (!Number.isInteger(page) || page < 1) throw new Error('预览页码必须大于等于 1')

    const result = await store.previewImport({
      filePath: options.filePath,
      previewPage: page,
      topMarginRatio: options.topMarginRatio,
      bottomMarginRatio: options.bottomMarginRatio,
    })
    previewPageCount.value = result.page_count
    previewText.value = result.text || '该页在当前裁剪配置下未提取到文本。'
  } catch (e) {
    previewText.value = ''
    previewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    previewLoading.value = false
  }
}

async function confirmImport() {
  importError.value = ''
  importing.value = true

  try {
    const options = buildImportOptions()
    const result = await store.importPdf(options)
    if (!result) return
    if (result.duplicate) {
      importError.value = '该文档已导入，MD5 重复。'
      importing.value = false
      return
    }
    // 关闭模态框，文档已出现在列表中
    showImportModal.value = false
    resetImportState(null)
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
    importing.value = false
  }
}

async function openDocById(docId: string) {
  const doc = store.documents.find(d => d.id === docId)
  if (!doc) return
  await openDoc(doc)
}

async function openDoc(doc: Doc) {
  selectedDoc.value = doc
  loadingChunks.value = true
  resetChunkViewState()
  // 如果是解析中的文档，记录为 watching 以便接收实时更新
  if (store.parsingProgress[doc.id]) {
    watchingDocId.value = doc.id
  }
  try {
    chunks.value = await store.getChunks(doc.id)
    assets.value = (await store.getDocAssets(doc.id)) as Array<{ id: string; file_path: string; asset_type: string }>
  } finally {
    loadingChunks.value = false
  }
}

async function deleteDoc(doc: Doc) {
  if (!confirm(`确认删除文档《${doc.title}》及其全部内容块？`)) return
  await store.remove(doc.id)
  if (selectedDoc.value?.id === doc.id) {
    selectedDoc.value = null
    chunks.value = []
    resetChunkViewState()
  }
}

async function toggleOfficial(doc: Doc) {
  const newValue = !doc.is_official
  await store.setOfficial(doc.id, newValue)
}

function toggleChunk(chunkId: string) {
  const next = new Set(expandedChunkIds.value)
  if (next.has(chunkId)) next.delete(chunkId)
  else next.add(chunkId)
  expandedChunkIds.value = next
}

function isChunkExpanded(chunkId: string) {
  return expandedChunkIds.value.has(chunkId)
}

function clearChunkSearch() {
  chunkSearchQuery.value = ''
  chunkViewError.value = ''
}

function escapeHtml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlightText(text: string) {
  const query = chunkSearchQuery.value.trim()
  const escapedText = escapeHtml(text)
  if (!query) return escapedText

  const pattern = new RegExp(`(${escapeRegExp(query)})`, 'gi')
  return escapedText.replace(pattern, '<mark class="chunk-highlight">$1</mark>')
}

function typeLabel(type: string): string {
  const map: Record<string, string> = {
    text: '文本', table: '表格', figure: '图示', page_summary: '摘要'
  }
  return map[type] ?? '文本'
}

const assets = ref<Array<{ id: string; file_path: string; asset_type: string }>>([])

async function viewAsset(assetId: string) {
  const asset = assets.value.find(a => a.id === assetId)
  if (!asset) {
    console.warn('[DocView] Asset not found:', assetId)
    return
  }
  try {
    await window.electronAPI.openPath(asset.file_path)
  } catch (e) {
    console.error('[DocView] Failed to open asset:', e)
  }
}

function startEdit(chunk: DocChunk) {
  editingChunkId.value = chunk.id
  editContent.value = chunk.content
}

function cancelEdit() {
  editingChunkId.value = null
  editContent.value = ''
}

async function saveEdit(chunk: DocChunk) {
  const newContent = editContent.value.trim()
  if (!newContent || newContent === chunk.content) {
    cancelEdit()
    return
  }
  editSaving.value = true
  try {
    await window.electronAPI.updateDocChunk(chunk.id, newContent)
    // Update local state
    chunk.content = newContent
    chunk.confidence = 1.0  // 人工确认
    cancelEdit()
  } catch (e) {
    console.error('[DocView] Failed to save edit:', e)
    alert('保存失败，请重试。')
  } finally {
    editSaving.value = false
  }
}

async function reparseChunk(chunk: DocChunk) {
  if (!selectedDoc.value) return
  reparseTarget.value = chunk
  reparseTopPercent.value = 7
  reparseBottomPercent.value = 7
  chunkViewError.value = ''
  reparsePreviewText.value = ''
  reparsePreviewError.value = ''
  showReparseModal.value = true
}

async function reparseLoadPreview() {
  const target = reparseTarget.value
  if (!target || !selectedDoc.value) return

  reparsePreviewError.value = ''
  reparsePreviewLoading.value = true
  try {
    const top = Number(reparseTopPercent.value)
    const bottom = Number(reparseBottomPercent.value)
    if (Number.isNaN(top) || top < 0 || top >= 100) throw new Error('顶部裁剪比例需在 0 到 99 之间')
    if (Number.isNaN(bottom) || bottom < 0 || bottom >= 100) throw new Error('底部裁剪比例需在 0 到 99 之间')
    if (top + bottom >= 100) throw new Error('顶部与底部裁剪比例之和必须小于 100')

    const result = await store.previewImport({
      filePath: selectedDoc.value.file_path,
      previewPage: target.page_num,
      topMarginRatio: top / 100,
      bottomMarginRatio: bottom / 100,
    })
    reparsePreviewText.value = result.text || '当前裁剪配置下未提取到文本。'
  } catch (e) {
    reparsePreviewText.value = ''
    reparsePreviewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    reparsePreviewLoading.value = false
  }
}

async function confirmReparse() {
  const target = reparseTarget.value
  if (!target || !selectedDoc.value) return

  const top = Number(reparseTopPercent.value)
  const bottom = Number(reparseBottomPercent.value)

  if (Number.isNaN(top) || top < 0 || top >= 100) {
    chunkViewError.value = '顶部裁剪比例需在 0 到 99 之间'
    return
  }
  if (Number.isNaN(bottom) || bottom < 0 || bottom >= 100) {
    chunkViewError.value = '底部裁剪比例需在 0 到 99 之间'
    return
  }
  if (top + bottom >= 100) {
    chunkViewError.value = '顶部与底部裁剪比例之和必须小于 100'
    return
  }

  reparsing.value = true
  chunkViewError.value = ''
  try {
    const res = await window.electronAPI.reparsePage({
      filePath: selectedDoc.value.file_path,
      docId: selectedDoc.value.id,
      pageNum: target.page_num,
      topMarginRatio: top / 100,
      bottomMarginRatio: bottom / 100,
      reTables: true,
      reVision: false,
      savePageImages: true,
    })
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const data = res.data as {
      chunks: DocChunk[]
      assets: Array<{ id: string; file_path: string; asset_type: string }>
    }

    // Remove old chunks of this page, add new ones
    const otherChunks = chunks.value.filter(c => c.page_num !== target.page_num)
    const newChunks = data.chunks.map((c, i) => ({
      ...c,
      id: c.id || `reparse-${Date.now()}-${i}`,
    }))
    chunks.value = [...otherChunks, ...newChunks].sort((a, b) =>
      a.page_num - b.page_num || (a.block_order ?? 0) - (b.block_order ?? 0)
    )
    // Merge assets
    if (data.assets?.length) {
      for (const a of data.assets) {
        if (!assets.value.find(ea => ea.id === a.id)) {
          assets.value.push(a)
        }
      }
    }
    showReparseModal.value = false
    reparseTarget.value = null
    chunkViewError.value = `第 ${target.page_num} 页重新解析完成，共 ${newChunks.length} 个块。`
  } catch (e) {
    chunkViewError.value = e instanceof Error ? e.message : String(e)
  } finally {
    reparsing.value = false
  }
}

function renderContent(chunk: DocChunk): string {
  if (chunk.chunk_type === 'table') {
    return renderMarkdownTable(chunk.content)
  }
  return highlightText(chunk.content)
}

function renderMarkdownTable(content: string): string {
  const lines = content.split('\n')
  // 提取标题行（以 ## 开头）
  const titleLines: string[] = []
  const tableLines: string[] = []
  let foundTable = false
  for (const line of lines) {
    if (!foundTable && line.startsWith('|')) {
      foundTable = true
    }
    if (foundTable) {
      tableLines.push(line)
    } else {
      titleLines.push(line)
    }
  }

  const titleHtml = titleLines.length > 0
    ? `<div class="table-title">${escapeHtml(titleLines.join('\n'))}</div>`
    : ''

  if (tableLines.length < 2) {
    return titleHtml + `<pre>${escapeHtml(content)}</pre>`
  }

  // 去掉分隔行（|---|---|）
  const dataLines = tableLines.filter((_, i) => i !== 1 || !/^\|[\s\-:|]+\|$/.test(tableLines[1]))

  let html = '<table class="md-table"><tbody>'
  for (let i = 0; i < dataLines.length; i++) {
    const cells = dataLines[i].split('|').filter((_, j, arr) => j > 0 && j < arr.length - 1)
    const tag = i === 0 ? 'th' : 'td'
    html += '<tr>'
    for (const cell of cells) {
      html += `<${tag}>${escapeHtml(cell.trim())}</${tag}>`
    }
    html += '</tr>'
  }
  html += '</tbody></table>'

  return titleHtml + html
}

async function jumpToPageNum(page: number) {
  if (!Number.isInteger(page) || page < 1) return
  const targetChunk = chunks.value.find((chunk) => chunk.page_num === page)
  if (!targetChunk) return
  const next = new Set(expandedChunkIds.value)
  next.add(targetChunk.id)
  expandedChunkIds.value = next
  await nextTick()
  document.getElementById(`chunk-${targetChunk.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function jumpToPage() {
  chunkViewError.value = ''
  const page = Number(pageJumpInput.value)
  if (!Number.isInteger(page) || page < 1) {
    chunkViewError.value = '请输入有效页码'
    return
  }

  const targetChunk = chunks.value.find((chunk) => chunk.page_num === page)
  if (!targetChunk) {
    chunkViewError.value = `未找到第 ${page} 页内容`
    return
  }

  const next = new Set(expandedChunkIds.value)
  next.add(targetChunk.id)
  expandedChunkIds.value = next

  await nextTick()
  document.getElementById(`chunk-${targetChunk.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

// ─── Tag cleaning & review handlers ────────────────────────────────────────
const cleaningLoading = ref(false)
const cleaningMessage = ref('')
const cleaningError = ref('')
const lastCleaningResult = ref<Record<string, unknown> | null>(null)  // 持久化清洗报告的引用

async function handleCleanChunks() {
  if (!selectedDoc.value || cleaningLoading.value) return
  cleaningLoading.value = true
  cleaningMessage.value = '🧹 正在分析标签…'
  cleaningError.value = ''
  lastCleaningResult.value = null
  try {
    const res = await store.cleanDocumentChunks(selectedDoc.value.id)
    if (!res || !(res as Record<string, unknown>).success) {
      const err = (res as Record<string, unknown>)?.error as Record<string, string>
      cleaningError.value = err?.message ?? '清洗失败：服务无响应'
      cleaningMessage.value = ''
      return
    }

    const result = ((res as Record<string, unknown>).data as Record<string, unknown>) ?? {}
    const report = (result.report as Record<string, unknown>) ?? {}
    const updated = (result.updated as number) ?? 0
    const corrections = (result.corrections as number) ?? 0

    cleaningMessage.value = `✅ 已清洗并保存到数据库 — ${updated} 块更新，${corrections} 条修正记录`
    cleaningError.value = ''
    lastCleaningResult.value = result

    // 强制重新加载 chunks（从 DB 读回清洗后的数据）
    if (selectedDoc.value) {
      loadingChunks.value = true
      chunks.value = await store.getChunks(selectedDoc.value.id)
      loadingChunks.value = false
    }
  } catch (e) {
    cleaningError.value = `清洗失败：${(e as Error).message}`
    cleaningMessage.value = ''
  } finally {
    cleaningLoading.value = false
  }
}

async function handleRollback() {
  if (!selectedDoc.value) return
  const logs = await store.getCleaningLogs(selectedDoc.value.id)
  if (!logs.length) {
    cleaningError.value = '没有可回滚的清洗记录'
    return
  }
  const latest = logs[0] as Record<string, unknown>
  try {
    cleaningLoading.value = true
    const res = await store.rollbackCleaning(latest.id as string)
    if ((res as unknown as Record<string, unknown>)?.success) {
      cleaningMessage.value = '✅ 已回滚清洗操作'
      cleaningError.value = ''
      // 重新加载
      await openDoc(selectedDoc.value)
    }
  } catch (e) {
    cleaningError.value = `回滚失败：${(e as Error).message}`
  } finally {
    cleaningLoading.value = false
  }
}

async function handleUpdateChunkTag(chunkId: string, tags: string[], confidence: number | null) {
  try {
    const res = await store.updateChunkTags(chunkId, tags, confidence)
    if (res && (res as Record<string, unknown>).success) {
      if (selectedDoc.value) {
        chunks.value = await store.getChunks(selectedDoc.value.id)
      }
      cleaningMessage.value = '✅ 标签已保存到数据库'
      cleaningError.value = ''
      setTimeout(() => { if (cleaningMessage.value === '✅ 标签已保存到数据库') cleaningMessage.value = '' }, 3000)
    } else {
      cleaningError.value = '保存失败'
    }
  } catch (e) {
    cleaningError.value = `保存失败：${(e as Error).message}`
    console.error('Update tag failed:', e)
  }
}

// ─── Review state for ⚠️ icon in chunks tab ─────────────────────────────────
function reviewedStorageKey(): string {
  return `tag-review:${selectedDoc.value?.id ?? 'unknown'}`
}
function isChunkReviewed(chunk: DocChunk): boolean {
  try {
    const raw = localStorage.getItem(reviewedStorageKey())
    if (raw) {
      const ids: string[] = JSON.parse(raw)
      return ids.includes(chunk.id)
    }
  } catch { /* ignore */ }
  return false
}
function showWarning(chunk: DocChunk): boolean {
  // 人工审核过的块不显示警告
  if (isChunkReviewed(chunk)) return false
  return chunk.confidence != null && chunk.confidence < 0.7
}
</script>

<template>
  <div class="doc-view">
    <div class="toolbar">
      <h2 class="view-title">文档库</h2>
      <span class="toolbar-hint">☆ 可将一本教材设为官方教材，学习计划中会优先关联</span>
      <button class="btn-primary" @click="openImportModal">
        + 导入 PDF
      </button>
    </div>
    <p v-if="importError && !showImportModal" class="error-text">{{ importError }}</p>

    <div class="main-layout">
      <div class="doc-list">
        <div v-if="store.loading" class="empty-tip">加载中…</div>
        <div v-else-if="store.documents.length === 0" class="empty-tip">
          <div style="font-size:40px;margin-bottom:8px">PDF</div>
          <div>还没有导入文档</div>
          <div style="font-size:12px;margin-top:4px;color:var(--c-text-3)">点击上方"导入 PDF"开始</div>
        </div>
        <div
          v-for="doc in store.documents"
          :key="doc.id"
          class="doc-item"
          :class="{
            active: selectedDoc?.id === doc.id,
            parsing: !!store.parsingProgress[doc.id],
            'doc-official': doc.is_official,
          }"
          @click="openDoc(doc)"
        >
          <div class="doc-icon">{{ store.parsingProgress[doc.id] ? '⏳' : 'PDF' }}</div>
          <div class="doc-info">
            <div class="doc-title">
              {{ doc.title }}
              <span v-if="doc.is_official" class="official-badge" title="官方教材">⭐ 官方教材</span>
            </div>
            <div v-if="store.parsingProgress[doc.id]" class="doc-meta parsing">
              <span class="parsing-label">解析中</span>
              <span class="parsing-progress">{{ docProgressText(doc.id) }}</span>
            </div>
            <div v-else class="doc-meta">{{ doc.page_count > 0 ? `${doc.page_count} 页` : '待解析' }} · {{ formatDate(doc.imported_at) }}</div>
            <div v-if="store.parsingProgress[doc.id]" class="doc-progress-detail">{{ docProgressDetail(doc.id) }}</div>
          </div>
          <button
            class="icon-btn official-btn"
            :class="{ active: doc.is_official }"
            :title="doc.is_official ? '取消官方教材标记' : '设为官方教材'"
            @click.stop="toggleOfficial(doc)"
          >{{ doc.is_official ? '★' : '☆' }}</button>
          <button class="icon-btn danger" title="删除" @click.stop="deleteDoc(doc)">×</button>
        </div>
      </div>

      <div class="chunks-panel">
        <div v-if="!selectedDoc" class="empty-tip chunk-empty">
          <div style="text-align:center;color:var(--c-border-2)">
            <div style="font-size:36px;margin-bottom:8px">→</div>
            <div>点击左侧文档查看内容块</div>
          </div>
        </div>
        <template v-else>
          <div class="chunks-header">
            <h3>{{ selectedDoc.title }}</h3>
            <div class="chunks-tabs">
              <button
                class="tab-btn"
                :class="{ active: chunkPanelTab === 'chunks' }"
                @click="chunkPanelTab = 'chunks'"
              >内容块</button>
              <button
                class="tab-btn"
                :class="{ active: chunkPanelTab === 'review' }"
                @click="chunkPanelTab = 'review'"
              >🔍 标签审核</button>
            </div>
            <span class="chunk-count" v-if="chunkPanelTab === 'chunks'">{{ loadingChunks ? '…' : filteredChunks.length }} / {{ chunks.length }} 个内容块</span>
          </div>
          <!-- 解析中提示 -->
          <div v-if="store.parsingProgress[selectedDoc.id]" class="parsing-bar">
            <div class="parsing-bar-track">
              <div class="parsing-bar-fill" :style="{ width: selectedDocParsePercent + '%' }"></div>
            </div>
            <span class="parsing-bar-text">{{ docProgressText(selectedDoc.id) }}</span>
          </div>

          <!-- 标签审核 Tab -->
          <template v-if="chunkPanelTab === 'review'">
            <!-- Cleaning status banner -->
            <div v-if="cleaningMessage" class="cleaning-banner cleaning-ok">{{ cleaningMessage }}</div>
            <div v-if="cleaningError" class="cleaning-banner cleaning-err">{{ cleaningError }}</div>
            <DocTagReview
              :chunks="chunks"
              :doc-page-count="selectedDoc.page_count"
              :loading="cleaningLoading"
              @clean="handleCleanChunks"
              @rollback="handleRollback"
              @update-tag="handleUpdateChunkTag"
            />
          </template>

          <!-- 内容块 Tab -->
          <template v-else>
          <div class="chunks-toolbar">
            <div class="search-wrap">
              <input
                v-model="chunkSearchQuery"
                class="search-input"
                placeholder="搜索内容、标签或页码…"
              />
              <button v-if="chunkSearchQuery" class="btn-secondary btn-small" @click="clearChunkSearch">清除</button>
            </div>
            <div class="jump-wrap">
              <input
                v-model="pageJumpInput"
                class="jump-input"
                type="number"
                min="1"
                step="1"
                placeholder="页码"
                @keyup.enter="jumpToPage"
              />
              <button class="btn-secondary btn-small" @click="jumpToPage">跳转</button>
            </div>
          </div>
          <p v-if="chunkViewError" class="error-text chunk-error">{{ chunkViewError }}</p>
          <div v-if="loadingChunks" class="empty-tip">加载内容块…</div>
          <div v-else-if="filteredChunks.length === 0" class="empty-tip">没有匹配的内容块</div>
          <div v-else class="chunks-list">
            <div
              v-for="chunk in filteredChunks"
              :id="`chunk-${chunk.id}`"
              :key="chunk.id"
              class="chunk-item"
              :class="{ expanded: isChunkExpanded(chunk.id) }"
              @click="toggleChunk(chunk.id)"
            >
              <div class="chunk-topline">
                <div class="chunk-page">
                  第 {{ chunk.page_num }} 页
                  <span class="chunk-type-tag" :class="`tag-${chunk.chunk_type || 'text'}`">
                    {{ typeLabel(chunk.chunk_type || 'text') }}
                  </span>
                  <span v-if="showWarning(chunk)" class="chunk-low-conf" title="低置信度，建议在标签审核中确认">
                    ⚠️
                  </span>
                </div>
                <div class="chunk-toggle">{{ isChunkExpanded(chunk.id) ? '收起' : '展开' }}</div>
              </div>
              <div
                class="chunk-content"
                :class="{ collapsed: !isChunkExpanded(chunk.id) }"
                @dblclick.stop="startEdit(chunk)"
              >
                <template v-if="editingChunkId === chunk.id">
                  <textarea
                    v-model="editContent"
                    class="chunk-edit-area"
                    rows="8"
                    @click.stop
                  ></textarea>
                  <div class="chunk-edit-actions">
                    <button class="btn-save-edit" :disabled="editSaving" @click.stop="saveEdit(chunk)">
                      {{ editSaving ? '保存中…' : '💾 保存' }}
                    </button>
                    <button class="btn-cancel-edit" @click.stop="cancelEdit">取消</button>
                    <span class="edit-hint">编辑后 confidence 将标记为 1.0（人工确认）</span>
                  </div>
                </template>
                <span v-else v-html="renderContent(chunk)"></span>
              </div>
              <div class="chunk-tags">
                <span
                  v-for="tag in chunk.knowledge_tags"
                  :key="tag"
                  class="tag"
                  v-html="highlightText(tag)"
                ></span>
                <span class="chunk-actions-right">
                  <button v-if="isChunkExpanded(chunk.id) && editingChunkId !== chunk.id"
                          class="btn-edit"
                          title="编辑内容"
                          @click.stop="startEdit(chunk)">
                    ✏️ 编辑
                  </button>
                  <button v-if="chunk.asset_id && isChunkExpanded(chunk.id)"
                          class="btn-asset-view"
                          title="查看原图"
                          @click.stop="viewAsset(chunk.asset_id)">
                    🖼 查看原图
                  </button>
                  <button v-if="isChunkExpanded(chunk.id)"
                          class="btn-reparse"
                          title="重新解析此页"
                          @click.stop="reparseChunk(chunk)">
                    🔄 重新生成
                  </button>
                </span>
              </div>
            </div>
          </div>
        </template>
        </template>
      </div>
    </div>

    <div v-if="showImportModal" class="modal-backdrop">
      <div class="modal import-modal">
        <div class="modal-header">
          <div>
            <h3>导入 PDF</h3>
            <div class="modal-subtitle">{{ selectedFile?.fileName }}</div>
          </div>
          <button class="icon-btn" @click="showImportModal = false">×</button>
        </div>

        <div class="modal-body">
          <div class="form-grid">
            <label class="field">
              <span>顶部裁剪</span>
              <div class="field-inline">
                <input v-model.number="topMarginPercent" type="number" min="0" max="99" step="1" />
                <span class="unit">%</span>
              </div>
            </label>

            <label class="field">
              <span>底部裁剪</span>
              <div class="field-inline">
                <input v-model.number="bottomMarginPercent" type="number" min="0" max="99" step="1" />
                <span class="unit">%</span>
              </div>
            </label>

            <label class="field">
              <span>起始页</span>
              <input v-model.number="startPage" type="number" min="1" step="1" />
            </label>

            <label class="field">
              <span>结束页</span>
              <input v-model="endPageInput" type="number" min="1" step="1" placeholder="留空表示最后一页" />
            </label>
          </div>

          <div class="import-options">
            <label class="checkbox-option">
              <input v-model="extractTables" type="checkbox" />
              <span>提取表格为 Markdown</span>
            </label>
            <label class="checkbox-option">
              <input v-model="savePageImages" type="checkbox" />
              <span>保存页面图片/图表资产</span>
            </label>
            <label class="checkbox-option">
              <input v-model="generateVisualSummary" type="checkbox" />
              <span>生成图片/流程图视觉摘要</span>
            </label>
            <label v-if="generateVisualSummary" class="field" style="margin-top: 4px;">
              <span>视觉摘要模式</span>
              <select v-model="visionMode" class="field-select">
                <option value="disabled">关闭</option>
                <option value="remote">远程模型</option>
                <option value="local">本地模型 (Ollama)</option>
              </select>
            </label>
            <p v-if="generateVisualSummary" class="hint-row" style="margin-top: 2px;">
              <span>⚠️ 视觉摘要将调用 AI 模型，增加导入耗时和 API 成本。</span>
            </p>
          </div>

          <div class="hint-row">
            <span>默认会跳过页面顶部和底部各 7% 区域。</span>
            <span v-if="previewPageCount">当前 PDF 共 {{ previewPageCount }} 页。</span>
          </div>

          <div class="preview-toolbar">
            <label class="field preview-page-field">
              <span>预览页码</span>
              <input v-model.number="previewPage" type="number" min="1" step="1" />
            </label>
            <button class="btn-secondary" :disabled="previewLoading" @click="loadPreview">
              {{ previewLoading ? '预览中…' : '预览提取结果' }}
            </button>
          </div>

          <p v-if="previewError" class="error-text">{{ previewError }}</p>
          <p v-if="importError" class="error-text">{{ importError }}</p>

          <div class="preview-panel">
            <div class="preview-header">单页预览</div>
            <div v-if="previewLoading" class="preview-content empty-tip">加载预览中…</div>
            <pre v-else class="preview-content">{{ previewText || '点击"预览提取结果"查看当前裁剪后的文本。' }}</pre>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" @click="showImportModal = false">取消</button>
          <button class="btn-primary" :disabled="importing" @click="confirmImport">
            {{ importing ? '导入中…' : '确认导入' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Reparse modal -->
    <div v-if="showReparseModal" class="modal-backdrop">
      <div class="modal reparse-modal">
        <div class="modal-header">
          <div>
            <h3>重新生成</h3>
            <div class="modal-subtitle">
              第 {{ reparseTarget?.page_num }} 页
              <button v-if="reparseTarget?.asset_id"
                      class="btn-asset-view"
                      style="margin-left: 8px;"
                      title="查看原图"
                      @click.stop="viewAsset(reparseTarget!.asset_id!)">
                🖼 查看原图
              </button>
            </div>
          </div>
          <button class="icon-btn" @click="showReparseModal = false">×</button>
        </div>

        <div class="modal-body">
          <p style="margin: 0 0 12px; color: var(--c-text-soft); font-size: 13px;">
            将重新提取该页的文本/表格/图示，并替换现有内容。请设置裁剪比例：
          </p>

          <div class="form-grid">
            <label class="field">
              <span>顶部裁剪</span>
              <div class="field-inline">
                <input v-model.number="reparseTopPercent" type="number" min="0" max="99" step="1" />
                <span class="unit">%</span>
              </div>
            </label>

            <label class="field">
              <span>底部裁剪</span>
              <div class="field-inline">
                <input v-model.number="reparseBottomPercent" type="number" min="0" max="99" step="1" />
                <span class="unit">%</span>
              </div>
            </label>
          </div>

          <div class="hint-row">
            <span>默认裁剪页面顶部和底部各 7% 区域（如页眉页脚）。</span>
          </div>

          <div class="preview-toolbar">
            <button class="btn-secondary" :disabled="reparsePreviewLoading" @click="reparseLoadPreview">
              {{ reparsePreviewLoading ? '预览中…' : '预览提取结果' }}
            </button>
          </div>

          <p v-if="reparsePreviewError" class="error-text">{{ reparsePreviewError }}</p>

          <div class="preview-panel">
            <div class="preview-header">裁剪预览</div>
            <div v-if="reparsePreviewLoading" class="preview-content empty-tip">加载预览中…</div>
            <pre v-else class="preview-content">{{ reparsePreviewText || '点击"预览提取结果"查看当前裁剪配置下的文本。' }}</pre>
          </div>

          <p v-if="chunkViewError" class="error-text">{{ chunkViewError }}</p>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" @click="showReparseModal = false">取消</button>
          <button class="btn-primary" :disabled="reparsing" @click="confirmReparse">
            {{ reparsing ? '生成中…' : '确认生成' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.doc-view { display: flex; flex-direction: column; height: 100%; gap: 12px; overflow: hidden; }
.toolbar { display: flex; align-items: center; gap: 12px; }
.view-title { font-size: 20px; font-weight: 700; color: var(--c-text); }
.toolbar-hint { font-size: 11px; color: var(--c-text-3); flex: 1; }
.error-text { color: #f87171; font-size: 13px; }

.btn-primary,
.btn-secondary {
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary { background: #1d4ed8; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-secondary { background: #243041; color: #dbe7ff; }
.btn-secondary:hover:not(:disabled) { background: #2c3b50; }
.btn-small { padding: 7px 12px; font-size: 12px; }
.btn-primary:disabled,
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.main-layout { flex: 1; display: grid; grid-template-columns: 280px 1fr; gap: 12px; min-height: 0; }

.doc-list {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.doc-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--c-border);
  cursor: pointer;
  transition: background 0.15s;
}
.doc-item:hover { background: #1a2740; }
.doc-item.active { background: #1e3a5f; }
.doc-icon {
  font-size: 12px;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #23314a;
  color: #93c5fd;
  font-weight: 700;
}
.doc-info { flex: 1; min-width: 0; }
.doc-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.doc-meta { font-size: 11px; color: var(--c-text-3); margin-top: 2px; }
.doc-meta.parsing {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #60a5fa;
}
.parsing-label {
  background: #1e3a5f;
  color: #60a5fa;
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}
.parsing-progress {
  font-size: 11px;
  white-space: nowrap;
}
.doc-progress-detail {
  font-size: 10px;
  color: #64748b;
  margin-top: 2px;
}
.doc-item.parsing {
  border-left: 3px solid #3b82f6;
}
.doc-item.doc-official {
  border-left: 3px solid #f59e0b;
  background: linear-gradient(90deg, #2d2410 0%, var(--c-panel) 12%);
}
.official-badge {
  font-size: 10px; font-weight: 600; color: #f59e0b;
  background: #3b2e10; padding: 1px 6px; border-radius: 3px;
  vertical-align: middle; margin-left: 4px; white-space: nowrap;
}
.icon-btn {
  background: none;
  border: 1px solid var(--c-border-2);
  border-radius: 6px;
  color: var(--c-text-2);
  width: 28px;
  height: 28px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.icon-btn.danger:hover { border-color: #f87171; color: #f87171; }
.icon-btn.official-btn { font-size: 16px; }
.icon-btn.official-btn:hover { border-color: #f59e0b; color: #f59e0b; }
.icon-btn.official-btn.active { color: #f59e0b; border-color: #f59e0b; background: #3b2e10; }

.chunks-panel {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.chunks-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--c-border);
}
.chunks-header h3 { font-size: 15px; font-weight: 600; color: var(--c-text); }
.chunk-count { font-size: 12px; color: var(--c-text-3); }
.chunks-tabs {
  display: flex;
  gap: 4px;
}
.tab-btn {
  padding: 4px 14px;
  border: 1px solid var(--c-border-2);
  border-radius: 6px;
  font-size: 12px;
  background: var(--c-bg);
  color: var(--c-text-2);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}
.tab-btn.active {
  background: #1e3a5f;
  color: #93c5fd;
  border-color: #33527d;
}
.tab-btn:hover:not(.active) { background: #1e293b; }
.chunks-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--c-border);
}
.chunk-error { padding: 0 16px; }
.cleaning-banner {
  margin: 8px 14px;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
}
.cleaning-ok { background: #14532d; color: #86efac; border: 1px solid #166534; }
.cleaning-err { background: #7f1d1d; color: #fca5a5; border: 1px solid #991b1b; }
.search-wrap,
.jump-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.search-wrap { flex: 1; }
.search-input,
.jump-input {
  border: 1px solid var(--c-border-2);
  border-radius: 8px;
  background: #111926;
  color: var(--c-text);
  padding: 8px 10px;
  font-size: 13px;
}
.search-input { flex: 1; min-width: 220px; }
.jump-input { width: 88px; }
.chunks-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 8px 40px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chunk-item {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
}
.chunk-item.expanded {
  border-color: #33527d;
  background: #152031;
}
.chunk-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.chunk-page { font-size: 11px; color: var(--c-text-3); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.chunk-toggle { font-size: 11px; color: #93c5fd; }
.chunk-type-tag {
  display: inline-block;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 16px;
  font-weight: 600;
}
.chunk-type-tag.tag-text { background: #334155; color: #94a3b8; }
.chunk-type-tag.tag-table { background: #14532d; color: #86efac; }
.chunk-type-tag.tag-figure { background: #4a044e; color: #e879f9; }
.chunk-type-tag.tag-page_summary { background: #1e3a5f; color: #93c5fd; }
.chunk-low-conf { font-size: 12px; cursor: help; }
.chunk-content {
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.chunk-content.collapsed {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chunk-content :deep(.table-title) {
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 8px;
}
.chunk-content :deep(.md-table) {
  border-collapse: collapse;
  width: 100%;
  margin: 6px 0 10px;
  font-size: 12px;
}
.chunk-content :deep(.md-table th),
.chunk-content :deep(.md-table td) {
  border: 1px solid #334155;
  padding: 4px 8px;
  text-align: left;
  vertical-align: top;
}
.chunk-content :deep(.md-table th) {
  background: #1e293b;
  color: #93c5fd;
  font-weight: 600;
}
.chunk-content :deep(.md-table td) {
  background: #0f172a;
  color: #cbd5e1;
}
.chunk-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; align-items: center; }
.chunk-actions-right { display: flex; gap: 4px; margin-left: auto; align-items: center; }
.btn-edit {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: #1e293b;
  color: #34d399;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-edit:hover { background: #334155; }
.btn-asset-view {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: #1e293b;
  color: #93c5fd;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-asset-view:hover { background: #334155; }
.btn-reparse {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: #1e293b;
  color: #fbbf24;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-reparse:hover { background: #334155; }
.chunk-edit-area {
  width: 100%;
  min-height: 120px;
  background: #0f172a;
  color: #e2e8f0;
  border: 1px solid #3b82f6;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.6;
  font-family: inherit;
  resize: vertical;
}
.chunk-edit-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.btn-save-edit {
  background: #1d4ed8;
  color: #fff;
  border: none;
  border-radius: 5px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
}
.btn-save-edit:hover:not(:disabled) { background: #2563eb; }
.btn-save-edit:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-cancel-edit {
  background: #334155;
  color: #cbd5e1;
  border: none;
  border-radius: 5px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}
.btn-cancel-edit:hover { background: #475569; }
.edit-hint { font-size: 10px; color: #64748b; }
.tag {
  display: inline-block;
  background: #1e3a5f;
  color: #93c5fd;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
}
:deep(.chunk-highlight) {
  background: #fde68a;
  color: #1f2937;
  padding: 0 2px;
  border-radius: 3px;
}
.empty-tip { text-align: center; padding: 48px; color: var(--c-border-2); font-size: 13px; }
.chunk-empty { height: 100%; display: flex; align-items: center; justify-content: center; }

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
}
.import-modal {
  width: min(920px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: hidden;
}
.reparse-modal {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: hidden;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--c-border);
}
.modal-header h3 { font-size: 16px; font-weight: 700; color: var(--c-text); }
.modal-subtitle { font-size: 12px; color: var(--c-text-3); margin-top: 4px; }
.modal-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--c-border);
}

.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--c-text-2); }
.field input {
  width: 100%;
  border: 1px solid var(--c-border);
  border-radius: 8px;
  background: #111926;
  color: var(--c-text);
  padding: 10px 12px;
  font-size: 14px;
}
.field-inline { display: flex; align-items: center; gap: 8px; }
.field-inline input { flex: 1; }
.unit { color: var(--c-text-3); font-size: 12px; }
.import-options {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 4px 0;
}
.checkbox-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--c-text);
  cursor: pointer;
}
.checkbox-option input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.field-select {
  width: 100%;
  padding: 6px 8px;
  background: var(--c-input-bg, #1e293b);
  color: var(--c-text, #e2e8f0);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: 13px;
}
.hint-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--c-text-3);
}
.preview-toolbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.preview-page-field { width: 180px; }

.preview-panel {
  border: 1px solid var(--c-border);
  border-radius: 10px;
  overflow: hidden;
  background: #101722;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.preview-header {
  flex-shrink: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--c-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}
.preview-content {
  margin: 0;
  padding: 14px 14px 40px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  line-height: 1.7;
  color: #d7e3f4;
  scroll-padding-bottom: 40px;
}

@media (max-width: 900px) {
  .main-layout { grid-template-columns: 1fr; }
  .chunks-toolbar { flex-direction: column; align-items: stretch; }
  .search-wrap,
  .jump-wrap,
  .hint-row,
  .preview-toolbar { flex-direction: column; align-items: stretch; }
  .form-grid { grid-template-columns: 1fr; }
  .search-input,
  .jump-input,
  .preview-page-field { width: 100%; min-width: 0; }
}

/* 解析进度条（右侧面板内） */
.parsing-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0 8px;
}
.parsing-bar-track {
  flex: 1;
  height: 4px;
  background: #1e293b;
  border-radius: 2px;
  overflow: hidden;
}
.parsing-bar-fill {
  height: 100%;
  background: #3b82f6;
  border-radius: 2px;
  transition: width 0.4s ease;
}
.parsing-bar-text {
  font-size: 11px;
  color: #60a5fa;
  white-space: nowrap;
}
</style>
