import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface LearningLog {
  id: string
  log_date: string
  time_slot: 'morning' | 'afternoon' | 'evening'
  task_id: string | null
  focus_minutes: number
  pomodoro_cycles: number
  interruption_count: number
  self_rating: number | null
  notes: string
  created_at: string
}

export interface DailyLogStats {
  date: string
  total_focus_minutes: number
  total_pomodoro_cycles: number
  total_interruptions: number
  avg_self_rating: number | null
}

export const useLearningLogStore = defineStore('learningLog', () => {
  const logs = ref<LearningLog[]>([])
  const dailyStats = ref<DailyLogStats[]>([])
  const loading = ref(false)

  async function loadLogs(from: string, to: string) {
    loading.value = true
    try {
      const res = await window.electronAPI.queryLogs({ from, to })
      if (res.success) logs.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function loadStats(days: number = 30) {
    const res = await window.electronAPI.getLogStats({ days })
    if (res.success) dailyStats.value = res.data
    return res
  }

  async function create(data: Omit<LearningLog, 'id' | 'created_at'>) {
    const res = await window.electronAPI.createLog(data)
    return res
  }

  async function update(id: string, changes: Partial<Omit<LearningLog, 'id' | 'created_at'>>) {
    const res = await window.electronAPI.updateLog({ id, changes })
    return res
  }

  async function remove(id: string) {
    const res = await window.electronAPI.deleteLog(id)
    return res
  }

  return { logs, dailyStats, loading, loadLogs, loadStats, create, update, remove }
})
