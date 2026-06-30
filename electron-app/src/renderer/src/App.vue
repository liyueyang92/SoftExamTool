<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const pythonReady = ref(false)
const pingResult = ref('')
const pinging = ref(false)

let cleanup: (() => void) | null = null

onMounted(() => {
  cleanup = window.electronAPI.onPythonStatus((status) => {
    pythonReady.value = status.ready
    if (!status.ready) pingResult.value = ''
  })
})

onUnmounted(() => {
  cleanup?.()
})

async function handlePing() {
  if (!pythonReady.value || pinging.value) return
  pinging.value = true
  pingResult.value = ''
  try {
    const result = await window.electronAPI.ping()
    pingResult.value = result.success ? `Python replied: ${result.data}` : `Error: ${result.error}`
  } finally {
    pinging.value = false
  }
}
</script>

<template>
  <div class="container">
    <h1 class="title">软考系统架构设计师考试辅助工具</h1>

    <div class="status-card" :class="pythonReady ? 'ready' : 'loading'">
      <span class="dot" />
      <span>{{ pythonReady ? 'Python 服务已就绪' : 'Python 服务启动中...' }}</span>
    </div>

    <button class="ping-btn" :disabled="!pythonReady || pinging" @click="handlePing">
      {{ pinging ? '请求中...' : '发送 Ping 测试' }}
    </button>

    <div v-if="pingResult" class="result">{{ pingResult }}</div>
  </div>
</template>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; }
</style>

<style scoped>
.container {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; min-height: 100vh; gap: 24px; padding: 24px;
}
.title { font-size: 22px; font-weight: 600; color: #f1f5f9; text-align: center; }
.status-card {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 24px; border-radius: 8px; font-size: 15px; font-weight: 500;
}
.status-card.ready { background: #14532d; color: #4ade80; }
.status-card.loading { background: #1e3a5f; color: #60a5fa; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
.status-card.loading .dot { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.ping-btn {
  padding: 10px 32px; background: #3b82f6; color: white; border: none;
  border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background 0.2s;
}
.ping-btn:hover:not(:disabled) { background: #2563eb; }
.ping-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.result {
  padding: 12px 20px; background: #1e293b; border: 1px solid #334155;
  border-radius: 6px; font-family: monospace; font-size: 14px; color: #a3e635;
}
</style>
