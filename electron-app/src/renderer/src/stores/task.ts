import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface ProgressPayload {
  taskId: string
  progress: number
  message: string
}

export const useTaskStore = defineStore('task', () => {
  const progressMap = ref(new Map<string, ProgressPayload>())

  function updateProgress(msg: ProgressPayload) {
    progressMap.value.set(msg.taskId, msg)
    if (msg.progress >= 100) {
      setTimeout(() => progressMap.value.delete(msg.taskId), 3000)
    }
  }

  function init() {
    window.electronAPI.onTaskProgress((msg) => updateProgress(msg))
  }

  return { progressMap, updateProgress, init }
})
