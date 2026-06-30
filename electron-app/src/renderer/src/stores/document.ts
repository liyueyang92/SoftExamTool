import { defineStore } from 'pinia'
import { ref } from 'vue'

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

  async function importPdf(): Promise<{ taskId?: string; duplicate?: boolean } | null> {
    const res = await window.electronAPI.importDocument()
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const data = res.data as { document: Doc; taskId?: string; duplicate?: boolean } | null
    if (!data) return null
    if (data.duplicate) {
      return { duplicate: true }
    }
    documents.value.unshift(data.document)
    if (data.taskId) importingTaskId.value = data.taskId
    return { taskId: data.taskId }
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

  function onImportComplete() {
    importingTaskId.value = null
    // Refresh to get updated page_count
    fetchAll()
  }

  return { documents, loading, importingTaskId, fetchAll, importPdf, remove, getChunks, onImportComplete }
})
