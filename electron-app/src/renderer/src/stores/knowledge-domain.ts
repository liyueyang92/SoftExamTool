import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface KnowledgeDomain {
  id: string
  parent_id: string | null
  name: string
  level: number
  sort_order: number
  suggested_min: number
  weight_pct: number
  is_required: number
  outline_ref: string
  created_at: string
}

export interface KnowledgeDomainTreeNode extends KnowledgeDomain {
  children: KnowledgeDomainTreeNode[]
}

export const useKnowledgeDomainStore = defineStore('knowledgeDomain', () => {
  const tree = ref<KnowledgeDomainTreeNode[]>([])
  const flatList = ref<Array<{ id: string; parent_id: string | null; name: string; level: number }>>([])
  const loading = ref(false)

  async function loadTree() {
    loading.value = true
    try {
      const res = await window.electronAPI.getDomainTree()
      if (res.success) tree.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function loadFlatList() {
    const res = await window.electronAPI.getFlatDomainList()
    if (res.success) flatList.value = res.data
  }

  async function importOutline(force = false) {
    const res = await window.electronAPI.importOutline({ force })
    if (res.success) await loadTree()
    return res
  }

  async function upsert(domain: Omit<KnowledgeDomain, 'created_at'>) {
    const res = await window.electronAPI.upsertDomain(domain)
    if (res.success) await loadTree()
    return res
  }

  async function batchUpsert(domains: Array<Omit<KnowledgeDomain, 'created_at'>>) {
    const res = await window.electronAPI.batchUpsertDomains({ domains })
    if (res.success) {
      await loadTree()
      await loadFlatList()
    }
    return res
  }

  async function remove(id: string) {
    const res = await window.electronAPI.deleteDomain(id)
    if (res.success) await loadTree()
    return res
  }

  async function getChunksForDocs(docIds: string[]) {
    const res = await window.electronAPI.getChunksForDocuments({ docIds })
    if (res.success) return res.data
    return []
  }

  return { tree, flatList, loading, loadTree, loadFlatList, importOutline, upsert, batchUpsert, remove, getChunksForDocs }
})
