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

export const useDocumentStore = defineStore('document', () => {
  const documents = ref<Doc[]>([])
  const loading = ref(false)
  const importingTaskId = ref<string | null>(null)

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

  async function importPdf(args?: PdfImportOptions): Promise<{ taskId?: string; duplicate?: boolean; reparsing?: boolean } | null> {
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
    if (data.taskId) importingTaskId.value = data.taskId
    return { taskId: data.taskId, reparsing: data.reparsing }
  }

  async function remove(id: string) {
    await window.electronAPI.deleteDocument(id)
    documents.value = documents.value.filter((d) => d.id !== id)
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

  function onImportComplete() {
    importingTaskId.value = null
    // Refresh to get updated page_count
    fetchAll()
  }

  return {
    documents,
    loading,
    importingTaskId,
    fetchAll,
    pickImportFile,
    previewImport,
    importPdf,
    remove,
    getChunks,
    getDocAssets,
    onImportComplete,
  }
})
