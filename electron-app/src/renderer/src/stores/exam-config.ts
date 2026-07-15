import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface ExamConfig {
  id: string
  exam_name: string
  exam_date: string | null
  syllabus_version: string
  target_score: number
  daily_min_minutes: number
  daily_max_minutes: number
  study_start_time: string
  created_at: string
  updated_at: string
}

export const useExamConfigStore = defineStore('examConfig', () => {
  const config = ref<ExamConfig | null>(null)
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      const res = await window.electronAPI.getExamConfig()
      if (res.success) config.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function save(data: Omit<ExamConfig, 'id' | 'created_at' | 'updated_at'>) {
    const res = await window.electronAPI.saveExamConfig(data)
    if (res.success) config.value = res.data
    return res
  }

  return { config, loading, load, save }
})
