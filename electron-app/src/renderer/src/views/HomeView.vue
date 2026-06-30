<script setup lang="ts">
import { useAppStore } from '../stores/app'
import { useTaskStore } from '../stores/task'

const app = useAppStore()
const tasks = useTaskStore()
</script>

<template>
  <div class="home">
    <h1>仪表盘</h1>

    <div class="cards">
      <div class="card" :class="app.pythonReady ? 'ok' : 'warn'">
        <div class="card-label">Python 服务</div>
        <div class="card-value">{{ app.pythonReady ? '运行中' : '启动中…' }}</div>
      </div>

      <div class="card" :class="app.dbReady ? 'ok' : 'warn'">
        <div class="card-label">数据库</div>
        <div class="card-value">{{ app.dbReady ? `v${app.dbVersion} 就绪` : '未就绪' }}</div>
      </div>

      <div class="card">
        <div class="card-label">活跃任务</div>
        <div class="card-value">{{ tasks.progressMap.size }}</div>
      </div>
    </div>

    <div v-if="tasks.progressMap.size > 0" class="progress-section">
      <h2>任务进度</h2>
      <div v-for="[id, p] in tasks.progressMap" :key="id" class="progress-item">
        <span class="task-id">{{ id.slice(0, 8) }}…</span>
        <div class="bar-wrap">
          <div class="bar" :style="{ width: p.progress + '%' }" />
        </div>
        <span class="pct">{{ p.progress }}%</span>
        <span class="msg">{{ p.message }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home { max-width: 800px; }
h1 { font-size: 22px; font-weight: 600; margin-bottom: 24px; color: #f1f5f9; }
h2 { font-size: 16px; font-weight: 600; margin: 24px 0 12px; color: #cbd5e1; }
.cards { display: flex; gap: 16px; flex-wrap: wrap; }
.card {
  padding: 16px 20px; border-radius: 10px; background: #1e293b;
  border: 1px solid #334155; min-width: 140px;
}
.card.ok   { border-color: #166534; }
.card.warn { border-color: #854d0e; }
.card-label { font-size: 12px; color: #64748b; margin-bottom: 6px; }
.card-value { font-size: 20px; font-weight: 600; color: #e2e8f0; }
.progress-section { margin-top: 8px; }
.progress-item {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 0; border-bottom: 1px solid #1e293b;
}
.task-id { font-family: monospace; font-size: 12px; color: #64748b; width: 80px; }
.bar-wrap { flex: 1; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
.bar { height: 100%; background: #3b82f6; border-radius: 3px; transition: width 0.3s; }
.pct { font-size: 12px; width: 36px; text-align: right; color: #94a3b8; }
.msg { font-size: 12px; color: #64748b; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
