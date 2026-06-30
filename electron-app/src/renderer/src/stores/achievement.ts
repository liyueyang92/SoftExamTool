import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Achievement } from '../../../preload/shared-types'

export const useAchievementStore = defineStore('achievement', () => {
  const achievements = ref<Achievement[]>([])
  const newlyUnlocked = ref<Achievement[]>([])
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      const res = await window.electronAPI.listAchievements()
      if (res.success) achievements.value = res.data as Achievement[]
    } finally {
      loading.value = false
    }
  }

  async function check() {
    const res = await window.electronAPI.checkAchievements()
    if (res.success && (res.data as Achievement[]).length > 0) {
      const freshUnlocked = res.data as Achievement[]
      newlyUnlocked.value = freshUnlocked
      // Refresh full list so newly-unlocked items show correct unlocked_at
      await load()
    }
  }

  function clearNewlyUnlocked() {
    newlyUnlocked.value = []
  }

  const unlockedCount = () => achievements.value.filter((a) => a.unlocked_at != null).length
  const totalCount = () => achievements.value.length

  return { achievements, newlyUnlocked, loading, load, check, clearNewlyUnlocked, unlockedCount, totalCount }
})
