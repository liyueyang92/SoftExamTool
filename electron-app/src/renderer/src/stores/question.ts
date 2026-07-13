import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import { toIpcPayload } from '../utils/ipc'

export type QuestionGroupType = 'custom' | 'past_exam' | 'ai_generated' | 'crawled' | 'manual_import'
export type ExamPeriod = 'H1' | 'H2'

export interface QuestionGroup {
  id: string
  name: string
  group_type: QuestionGroupType
  exam_year: number | null
  exam_period: ExamPeriod | null
  description: string
  created_at: string
  updated_at: string
}

export interface QuestionGroupDraft {
  id?: string
  name: string
  group_type?: QuestionGroupType
  exam_year?: number | null
  exam_period?: ExamPeriod | null
  description?: string
}

export interface Question {
  id: string
  group_id: string | null
  question_set_id: string | null
  question_set_order: number
  type: 'single' | 'multiple' | 'case' | 'essay'
  content: string
  options: string[] | null
  answer: string | null
  explanation: string | null
  knowledge_tags: string[]
  difficulty: number
  source_type: string
  source_url?: string | null
  is_favorite: number
  group_name?: string | null
  group_type?: QuestionGroupType | null
  exam_year?: number | null
  exam_period?: ExamPeriod | null
  created_at: string
}

export interface QuestionDraft {
  group_id?: string | null
  question_set_id?: string | null
  question_set_order?: number | null
  type: Question['type']
  content: string
  options?: string[] | null
  answer?: string | null
  explanation?: string | null
  knowledge_tags?: string[]
  difficulty?: number
  source_type?: string
  source_url?: string | null
}

export interface QuestionFilter {
  group_id?: string
  group_name?: string
  group_type?: QuestionGroupType
  exam_year?: number
  exam_period?: ExamPeriod
  type?: string
  difficulty?: number
  source_type?: string
  knowledge_tag?: string
  is_favorite?: boolean
  page?: number
  pageSize?: number
}

export const useQuestionStore = defineStore('question', () => {
  const groups = ref<QuestionGroup[]>([])
  const groupsLoading = ref(false)
  const questions = ref<Question[]>([])
  const total = ref(0)
  const loading = ref(false)
  const filter = reactive<QuestionFilter>({ page: 1, pageSize: 20 })
  const stats = ref<Record<string, unknown>>({})

  async function fetchPage() {
    loading.value = true
    try {
      const res = await window.electronAPI.queryQuestions(toIpcPayload({ ...filter }))
      if (res.success) {
        questions.value = res.data.items as Question[]
        total.value = res.data.total
      }
    } finally {
      loading.value = false
    }
  }

  async function fetchGroups() {
    groupsLoading.value = true
    try {
      const res = await window.electronAPI.listQuestionGroups()
      if (res.success) groups.value = res.data as QuestionGroup[]
    } finally {
      groupsLoading.value = false
    }
  }

  async function saveGroup(group: QuestionGroupDraft): Promise<QuestionGroup> {
    const res = await window.electronAPI.upsertQuestionGroup(toIpcPayload(group))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const updated = res.data as QuestionGroup
    const idx = groups.value.findIndex((g) => g.id === updated.id)
    if (idx >= 0) groups.value[idx] = updated
    else groups.value.unshift(updated)
    return updated
  }

  async function removeGroup(id: string) {
    const res = await window.electronAPI.deleteQuestionGroup(id)
    if (!res.success) throw new Error((res.error as { message: string }).message)
    groups.value = groups.value.filter((g) => g.id !== id)
  }

  async function moveQuestions(fromGroupId: string, toGroupId: string): Promise<number> {
    const res = await window.electronAPI.moveQuestionsToGroup({ fromGroupId, toGroupId })
    if (!res.success) throw new Error((res.error as { message: string }).message)
    await fetchGroups()
    return res.data as number
  }

  async function ensureGroupId(args: { groupId?: string | null; newGroup?: QuestionGroupDraft | null }): Promise<string | null> {
    if (args.groupId) return args.groupId
    if (args.newGroup?.name?.trim()) {
      const created = await saveGroup(args.newGroup)
      return created.id
    }
    return null
  }

  async function search(q: string): Promise<Question[]> {
    const res = await window.electronAPI.searchQuestions(toIpcPayload({ q }))
    if (res.success) return res.data as Question[]
    return []
  }

  async function insert(q: QuestionDraft): Promise<Question | null> {
    const res = await window.electronAPI.insertQuestion(toIpcPayload(q))
    if (res.success) {
      await fetchPage()
      return res.data as Question
    }
    return null
  }

  async function batchImport(qs: unknown[]): Promise<number> {
    const res = await window.electronAPI.batchInsertQuestions(toIpcPayload({ questions: qs }))
    if (res.success) {
      await fetchPage()
      await loadStats()
      return (res.data as { count: number }).count
    }
    return 0
  }

  async function exportData(exportFilter?: QuestionFilter): Promise<{ count: number; filePath: string; imageCount?: number } | null> {
    const res = await window.electronAPI.exportQuestions(toIpcPayload({ filter: exportFilter ?? filter }))
    if (res.success) return res.data as { count: number; filePath: string; imageCount?: number }
    return null
  }

  async function importFile(args: { groupId?: string | null; newGroup?: QuestionGroupDraft | null }): Promise<{ count: number; imageCount?: number }> {
    const groupId = await ensureGroupId(args)
    const res = await window.electronAPI.importQuestionsFile(toIpcPayload({ group_id: groupId }))
    if (res.success) {
      await fetchPage()
      await loadStats()
      return res.data as { count: number; imageCount?: number }
    }
    throw new Error((res.error as { message: string }).message)
  }

  async function update(id: string, changes: Partial<Question>) {
    const res = await window.electronAPI.updateQuestion(toIpcPayload({ id, changes }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const idx = questions.value.findIndex((q) => q.id === id)
    if (idx >= 0) questions.value[idx] = { ...questions.value[idx], ...changes }
    if (changes.group_id !== undefined) await fetchPage()
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
    if (
      f.group_id !== undefined ||
      f.group_name !== undefined ||
      f.group_type !== undefined ||
      f.exam_year !== undefined ||
      f.exam_period !== undefined ||
      f.type !== undefined ||
      f.difficulty !== undefined ||
      f.source_type !== undefined ||
      f.knowledge_tag !== undefined ||
      f.is_favorite !== undefined
    ) {
      filter.page = 1
    }
  }

  return {
    groups, groupsLoading, questions, total, loading, filter, stats,
    fetchGroups, saveGroup, removeGroup, moveQuestions, ensureGroupId,
    fetchPage, search, insert, batchImport, exportData, importFile, update, remove, toggleFavorite, loadStats, setFilter,
  }
})
