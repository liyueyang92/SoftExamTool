import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Notification {
  id: string
  type: 'daily_plan' | 'progress_warning' | 'streak_milestone' | 'countdown' | 'pomodoro_end' | 'achievement' | 'system'
  title: string
  body: string
  action_url: string | null
  is_read: number
  created_at: string
}

export const useNotificationStore = defineStore('notification', () => {
  const notifications = ref<Notification[]>([])
  const unreadCount = ref(0)
  const loading = ref(false)

  async function load(limit: number = 50) {
    loading.value = true
    try {
      const res = await window.electronAPI.listNotifications({ limit })
      if (res.success) {
        notifications.value = res.data
        unreadCount.value = res.data.filter((n) => !n.is_read).length
      }
    } finally {
      loading.value = false
    }
  }

  async function markRead(id?: string) {
    await window.electronAPI.markNotificationRead(id)
    if (id) {
      const n = notifications.value.find((n) => n.id === id)
      if (n) {
        n.is_read = 1
        unreadCount.value = Math.max(0, unreadCount.value - 1)
      }
    } else {
      notifications.value.forEach((n) => (n.is_read = 1))
      unreadCount.value = 0
    }
  }

  return { notifications, unreadCount, loading, load, markRead }
})
