<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { RouterView } from 'vue-router'
import AppLayout from './layouts/AppLayout.vue'
import { useAppStore } from './stores/app'
import { useTaskStore } from './stores/task'
import { useAchievementStore } from './stores/achievement'
import type { Achievement } from '../../../preload/index.d'

const appStore = useAppStore()
const taskStore = useTaskStore()
const achStore = useAchievementStore()

let removeAchListener: (() => void) | null = null

onMounted(() => {
  appStore.init()
  taskStore.init()

  // Listen for achievement unlocks pushed from main process
  removeAchListener = window.electronAPI.onAchievementUnlocked((newly: Achievement[]) => {
    achStore.newlyUnlocked.push(...newly)
    // Auto-dismiss after 5 seconds
    setTimeout(() => achStore.clearNewlyUnlocked(), 5000)
  })
})

onUnmounted(() => {
  removeAchListener?.()
})
</script>

<template>
  <AppLayout>
    <RouterView />
  </AppLayout>
</template>
