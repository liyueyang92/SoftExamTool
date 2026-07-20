import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PdfImportOptions, PdfImportResult, PdfImportSelection, PdfPreviewResult } from '../../../preload/shared-types'
import { toIpcPayload } from '../utils/ipc'

export interface Doc {
  id: string
  title: string
  file_path: string
  page_count: number
  md5: string
  imported_at: string
  is_official: number
}

export interface DocChunk {
  id: string
  doc_id: string
  page_num: number
  content: string
  knowledge_tags: string[]
  chunk_type: 'text' | 'table' | 'figure' | 'page_summary'
  asset_id: string | null
  confidence: number | null
  source_engine: string
  block_order: number
  bbox: string | null
}

export interface DocParsingProgress {
  taskId: string
  docId: string
  totalPages: number
  parsedPages: number[]
  chunkCount: number
}

export const useDocumentStore = defineStore('document', () => {
  const documents = ref<Doc[]>([])
  const loading = ref(false)
  const importingTaskId = ref<string | null>(null)
  // 记录每个文档的解析进度（key 为 docId）
  const parsingProgress = ref<Record<string, DocParsingProgress>>({})

  async function fetchAll() {
    loading.value = true
    try {
      const res = await window.electronAPI.listDocuments()
      if (res.success) documents.value = res.data as Doc[]
    } finally {
      loading.value = false
    }
  }

  async function pickImportFile(): Promise<PdfImportSelection | null> {
    const res = await window.electronAPI.pickDocumentFile()
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return (res.data as PdfImportSelection | null) ?? null
  }

  async function previewImport(args: {
    filePath: string
    previewPage: number
    topMarginRatio?: number
    bottomMarginRatio?: number
  }): Promise<PdfPreviewResult> {
    const res = await window.electronAPI.previewDocumentImport(toIpcPayload(args))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    return res.data as PdfPreviewResult
  }

  async function importPdf(args?: PdfImportOptions): Promise<{ taskId?: string; duplicate?: boolean; reparsing?: boolean; docId?: string } | null> {
    const res = await window.electronAPI.importDocument(args ? toIpcPayload(args) : undefined)
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const data = res.data as (PdfImportResult & { document: Doc }) | null
    if (!data) return null
    if (data.duplicate) {
      return { duplicate: true }
    }
    const index = documents.value.findIndex((doc) => doc.id === data.document.id)
    if (index >= 0) {
      documents.value[index] = data.document
    } else {
      documents.value.unshift(data.document)
    }
    if (data.taskId) {
      importingTaskId.value = data.taskId
      // 初始化解析进度跟踪
      parsingProgress.value = {
        ...parsingProgress.value,
        [data.document.id]: {
          taskId: data.taskId,
          docId: data.document.id,
          totalPages: 0,
          parsedPages: [],
          chunkCount: 0,
        },
      }
    }
    return { taskId: data.taskId, reparsing: data.reparsing, docId: data.document.id }
  }

  async function remove(id: string) {
    await window.electronAPI.deleteDocument(id)
    documents.value = documents.value.filter((d) => d.id !== id)
  }

  async function setOfficial(docId: string, isOfficial: boolean) {
    const res = await window.electronAPI.setDocumentOfficial(toIpcPayload({ docId, isOfficial }))
    if (res.success) {
      // 更新本地状态：全体取消，再设置目标
      documents.value = documents.value.map((d) => ({
        ...d,
        is_official: d.id === docId && isOfficial ? 1 : (isOfficial ? 0 : d.is_official),
      }))
      if (res.data.is_official) {
        // 官方教材排到列表最前面
        documents.value.sort((a, b) => b.is_official - a.is_official)
      }
    }
  }

  async function getChunks(docId: string): Promise<DocChunk[]> {
    const res = await window.electronAPI.getDocChunks(docId)
    if (res.success) return res.data as DocChunk[]
    return []
  }

  async function getDocAssets(docId: string): Promise<unknown[]> {
    const res = await window.electronAPI.getDocAssets(docId)
    if (res.success) return res.data as unknown[]
    return []
  }

  function updateParsingProgress(taskId: string, pageNum: number, totalPages: number, chunkCount: number) {
    // 找到对应 docId
    for (const [docId, prog] of Object.entries(parsingProgress.value)) {
      if (prog.taskId === taskId) {
        const pages = [...prog.parsedPages]
        if (!pages.includes(pageNum)) {
          pages.push(pageNum)
        }
        parsingProgress.value = {
          ...parsingProgress.value,
          [docId]: {
            ...prog,
            totalPages,
            parsedPages: pages,
            chunkCount: prog.chunkCount + chunkCount,
          },
        }
        return docId
      }
    }
    return null
  }

  function onImportComplete() {
    if (importingTaskId.value) {
      // 清理该 task 对应的解析进度
      for (const [docId, prog] of Object.entries(parsingProgress.value)) {
        if (prog.taskId === importingTaskId.value) {
          const rest = { ...parsingProgress.value }
          delete rest[docId]
          parsingProgress.value = rest
          break
        }
      }
    }
    importingTaskId.value = null
    // Refresh to get updated page_count
    fetchAll()
  }

  function clearParsingProgress(docId: string) {
    if (parsingProgress.value[docId]) {
      const rest = { ...parsingProgress.value }
      delete rest[docId]
      parsingProgress.value = rest
    }
  }

  // ─── Phase 4: Tag cleaning & review ──────────────────────────────────────

  const cleaningDocId = ref<string | null>(null)
  const cleaningResult = ref<Record<string, unknown> | null>(null)

  async function cleanDocumentChunks(docId: string) {
    cleaningDocId.value = docId
    cleaningResult.value = null
    try {
      const res = await window.electronAPI.cleanDocChunks({ docId } as unknown as Record<string, unknown>)
      if ((res as unknown as { success: boolean }).success) {
        cleaningResult.value = (res as unknown as { data: Record<string, unknown> }).data
      }
      return res
    } finally {
      cleaningDocId.value = null
    }
  }

  async function rollbackCleaning(cleaningLogId: string) {
    const res = await window.electronAPI.rollbackCleaning({ cleaningLogId } as unknown as Record<string, unknown>)
    if ((res as unknown as { success: boolean }).success) {
      cleaningResult.value = null
    }
    return res
  }

  async function updateChunkTags(chunkId: string, tags: string[], confidence: number | null) {
    const res = await window.electronAPI.updateChunkTags({ chunkId, tags, confidence } as unknown as Record<string, unknown>)
    return res
  }

  async function getCleaningLogs(docId: string) {
    const res = await window.electronAPI.getCleaningLogs(docId)
    if ((res as unknown as { success: boolean }).success) return (res as unknown as { data: unknown[] }).data
    return []
  }

  return {
    documents,
    loading,
    importingTaskId,
    parsingProgress,
    fetchAll,
    pickImportFile,
    previewImport,
    importPdf,
    remove,
    setOfficial,
    getChunks,
    getDocAssets,
    updateParsingProgress,
    onImportComplete,
    clearParsingProgress,
    cleaningDocId,
    cleaningResult,
    cleanDocumentChunks,
    rollbackCleaning,
    updateChunkTags,
    getCleaningLogs,
  }
})
