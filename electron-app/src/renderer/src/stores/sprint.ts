import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface SprintStatus {
  isActive: boolean
  daysUntilExam: number | null
  dailyCardsReady: boolean
  essayDueToday: boolean
}

export interface SprintCardItem {
  tag: string
  keyPoints: string[]
  relatedErrorCount: number
}

export interface SprintCard {
  date: string
  items: SprintCardItem[]
  generatedAt: string
}

export const useSprintStore = defineStore('sprint', () => {
  const status = ref<SprintStatus>({
    isActive: false,
    daysUntilExam: null,
    dailyCardsReady: false,
    essayDueToday: false,
  })
  const dailyCard = ref<SprintCard | null>(null)
  const loading = ref(false)

  const countdownDisplay = computed(() => {
    if (status.value.daysUntilExam === null) return ''
    const d = status.value.daysUntilExam
    if (d === 0) return '今天考试！'
    return `${d} 天`
  })

  async function loadStatus() {
    loading.value = true
    try {
      const res = await window.electronAPI.getSprintStatus()
      if (res.success) status.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function loadDailyCard() {
    const res = await window.electronAPI.getDailyCard()
    if (res.success) dailyCard.value = res.data
    return res
  }

  async function activate(planId: string) {
    await window.electronAPI.activateSprintMode(planId)
    await loadStatus()
  }

  return { status, dailyCard, loading, countdownDisplay, loadStatus, loadDailyCard, activate }
})
