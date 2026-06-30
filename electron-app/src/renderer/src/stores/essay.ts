import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface Essay {
  id: string
  title: string
  question: string
  version: number
  word_count: number
  created_at: string
  updated_at: string
}

export interface EssaySection {
  id: string
  essay_id: string
  section_key: string
  content: string
  word_count: number
  updated_at: string
}

export interface EssayVersion {
  id: string
  essay_id: string
  version: number
  saved_at: string
}

export interface EssayMaterial {
  id: string
  project_name: string
  background: string
  challenges: string
  solution: string
  outcomes: string
  knowledge_tags: string[]
  created_at: string
  updated_at: string
}

export const SECTION_CONFIG = [
  { key: 'abstract',   label: '摘要',     target: 300,  hint: '简明描述论文主要内容（300字）' },
  { key: 'background', label: '背景与挑战', target: 500,  hint: '项目背景、行业现状、主要挑战（500字）' },
  { key: 'solution',   label: '技术方案',  target: 1500, hint: '架构设计、关键技术、方案对比（1500字）' },
  { key: 'practice',   label: '项目实践',  target: 1000, hint: '实施过程、遇到的问题与解决（1000字）' },
  { key: 'summary',    label: '总结',     target: 300,  hint: '项目收获、改进方向、个人体会（300字）' },
] as const

export const useEssayStore = defineStore('essay', () => {
  const essays = ref<Essay[]>([])
  const activeEssay = ref<Essay | null>(null)
  const sections = ref<EssaySection[]>([])
  const versions = ref<EssayVersion[]>([])
  const materials = ref<EssayMaterial[]>([])
  const loading = ref(false)
  const suggesting = ref<Record<string, boolean>>({})
  const suggestions = ref<Record<string, string>>({})

  const totalWordCount = computed(() => sections.value.reduce((sum, s) => sum + s.word_count, 0))

  async function fetchList() {
    loading.value = true
    try {
      const res = await window.electronAPI.listEssays()
      if (res.success) essays.value = res.data as Essay[]
    } finally {
      loading.value = false
    }
  }

  async function openEssay(id: string) {
    const res = await window.electronAPI.getEssay(id)
    if (!res.success || !res.data) return
    const { essay, sections: secs } = res.data as { essay: Essay; sections: EssaySection[] }
    activeEssay.value = essay
    sections.value = secs
    suggestions.value = {}
  }

  async function create(title?: string) {
    const res = await window.electronAPI.createEssay({ title })
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const essay = res.data as Essay
    essays.value.unshift(essay)
    return essay
  }

  async function updateSection(sectionKey: string, content: string) {
    if (!activeEssay.value) return
    const res = await window.electronAPI.updateEssaySection({
      essayId: activeEssay.value.id,
      sectionKey,
      content,
    })
    if (!res.success) return
    const updated = res.data as EssaySection
    const idx = sections.value.findIndex((s) => s.section_key === sectionKey)
    if (idx >= 0) sections.value[idx] = updated
    if (activeEssay.value) {
      activeEssay.value.word_count = sections.value.reduce((sum, s) => sum + s.word_count, 0)
    }
  }

  async function updateMeta(patch: { title?: string; question?: string }) {
    if (!activeEssay.value) return
    await window.electronAPI.updateEssayMeta({ id: activeEssay.value.id, ...patch })
    Object.assign(activeEssay.value, patch)
    const idx = essays.value.findIndex((e) => e.id === activeEssay.value!.id)
    if (idx >= 0) Object.assign(essays.value[idx], patch)
  }

  async function saveVersion() {
    if (!activeEssay.value) return
    const res = await window.electronAPI.saveEssayVersion(activeEssay.value.id)
    if (res.success) {
      activeEssay.value.version = (res.data as EssayVersion).version
      await fetchVersions()
    }
  }

  async function fetchVersions() {
    if (!activeEssay.value) return
    const res = await window.electronAPI.listEssayVersions(activeEssay.value.id)
    if (res.success) versions.value = res.data as EssayVersion[]
  }

  async function restoreVersion(versionId: string) {
    if (!activeEssay.value) return
    await window.electronAPI.restoreEssayVersion({ essayId: activeEssay.value.id, versionId })
    await openEssay(activeEssay.value.id)
  }

  async function removeEssay(id: string) {
    await window.electronAPI.deleteEssay(id)
    essays.value = essays.value.filter((e) => e.id !== id)
    if (activeEssay.value?.id === id) { activeEssay.value = null; sections.value = [] }
  }

  async function fetchMaterials() {
    const res = await window.electronAPI.listEssayMaterials()
    if (res.success) materials.value = res.data as EssayMaterial[]
  }

  async function upsertMaterial(mat: Partial<EssayMaterial>): Promise<EssayMaterial> {
    const res = await window.electronAPI.upsertEssayMaterial(mat)
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const updated = res.data as EssayMaterial
    const idx = materials.value.findIndex((m) => m.id === updated.id)
    if (idx >= 0) materials.value[idx] = updated
    else materials.value.unshift(updated)
    return updated
  }

  async function removeMaterial(id: string) {
    await window.electronAPI.deleteEssayMaterial(id)
    materials.value = materials.value.filter((m) => m.id !== id)
  }

  async function getSuggestion(sectionKey: string, sectionLabel: string, wordTarget: number) {
    if (!activeEssay.value) return
    const sec = sections.value.find((s) => s.section_key === sectionKey)
    if (!sec) return
    suggesting.value = { ...suggesting.value, [sectionKey]: true }
    try {
      const res = await window.electronAPI.essayAiSuggest({
        section_key: sectionKey,
        section_label: sectionLabel,
        current_content: sec.content,
        word_target: wordTarget,
      })
      if (res.success) suggestions.value = { ...suggestions.value, [sectionKey]: res.data.suggestions }
    } finally {
      suggesting.value = { ...suggesting.value, [sectionKey]: false }
    }
  }

  return {
    essays, activeEssay, sections, versions, materials, loading, suggesting, suggestions,
    totalWordCount,
    fetchList, openEssay, create, updateSection, updateMeta,
    saveVersion, fetchVersions, restoreVersion, removeEssay,
    fetchMaterials, upsertMaterial, removeMaterial, getSuggestion,
  }
})
