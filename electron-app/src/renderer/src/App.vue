<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterView } from 'vue-router'
import AppLayout from './layouts/AppLayout.vue'
import { useAppStore } from './stores/app'
import { useTaskStore } from './stores/task'

const appStore = useAppStore()
const taskStore = useTaskStore()

onMounted(() => {
  appStore.init()
  taskStore.init()
})
</script>

<template>
  <AppLayout>
    <RouterView />
  </AppLayout>
</template>
