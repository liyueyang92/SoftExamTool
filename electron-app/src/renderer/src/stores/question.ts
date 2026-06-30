import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'

export interface Question {
  id: string
  type: 'single' | 'multiple' | 'case' | 'essay'
  content: string
  options: string[] | null
  answer: string | null
  explanation: string | null
  knowledge_tags: string[]
  difficulty: number
  source_type: string
  is_favorite: number
  created_at: string
}

export interface QuestionFilter {
  type?: string
  difficulty?: number
  source_type?: string
  knowledge_tag?: string
  is_favorite?: boolean
  page?: number
  pageSize?: number
}

export const useQuestionStore = defineStore('question', () => {
  const questions = ref<Question[]>([])
  const total = ref(0)
  const loading = ref(false)
  const filter = reactive<QuestionFilter>({ page: 1, pageSize: 20 })
  const stats = ref<Record<string, unknown>>({})

  async function fetchPage() {
    loading.value = true
    try {
      const res = await window.electronAPI.queryQuestions({ ...filter })
      if (res.success) {
        questions.value = res.data.items as Question[]
        total.value = res.data.total
      }
    } finally {
      loading.value = false
    }
  }

  async function search(q: string): Promise<Question[]> {
    const res = await window.electronAPI.searchQuestions({ q })
    if (res.success) return res.data as Question[]
    return []
  }

  async function insert(q: Omit<Question, 'id' | 'created_at' | 'is_favorite'>): Promise<Question | null> {
    const res = await window.electronAPI.insertQuestion(q)
    if (res.success) {
      await fetchPage()
      return res.data as Question
    }
    return null
  }

  async function batchImport(qs: unknown[]): Promise<number> {
    const res = await window.electronAPI.batchInsertQuestions({ questions: qs })
    if (res.success) {
      await fetchPage()
      await loadStats()
      return (res.data as { count: number }).count
    }
    return 0
  }

  async function update(id: string, changes: Partial<Question>) {
    await window.electronAPI.updateQuestion({ id, changes })
    const idx = questions.value.findIndex((q) => q.id === id)
    if (idx >= 0) questions.value[idx] = { ...questions.value[idx], ...changes }
  }

  async function remove(id: string) {
    await window.electronAPI.deleteQuestion(id)
    questions.value = questions.value.filter((q) => q.id !== id)
    total.value = Math.max(0, total.value - 1)
  }

  async function toggleFavorite(id: string) {
    const res = await window.electronAPI.toggleFavorite(id)
    if (res.success) {
      const q = questions.value.find((x) => x.id === id)
      if (q) q.is_favorite = (res.data as { is_favorite: number }).is_favorite
    }
  }

  async function loadStats() {
    const res = await window.electronAPI.getQuestionStats()
    if (res.success) stats.value = res.data as Record<string, unknown>
  }

  function setFilter(f: Partial<QuestionFilter>) {
    Object.assign(filter, f)
    if (f.type !== undefined || f.difficulty !== undefined || f.source_type !== undefined || f.knowledge_tag !== undefined || f.is_favorite !== undefined) {
      filter.page = 1
    }
  }

  return { questions, total, loading, filter, stats, fetchPage, search, insert, batchImport, update, remove, toggleFavorite, loadStats, setFilter }
})
