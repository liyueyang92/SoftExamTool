<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { usePomodoroStore } from '../stores/pomodoro'
import { useAchievementStore } from '../stores/achievement'

const pomo = usePomodoroStore()
const ach = useAchievementStore()

function handleKeydown(e: KeyboardEvent) {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault()
    if (pomo.running) pomo.pause()
    else if (pomo.phase === 'idle') pomo.start()
    else pomo.resume()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  ach.load()
})
onUnmounted(() => document.removeEventListener('keydown', handleKeydown))

const PHASE_COLORS: Record<string, string> = {
  idle: '#475569',
  work: '#dc2626',
  'short-break': '#16a34a',
  'long-break': '#2563eb',
}
</script>

<template>
  <div class="pomo-view">
    <h2 class="page-title">番茄钟</h2>

    <div class="pomo-card">
      <!-- Phase indicator -->
      <div class="phase-tabs">
        <span
          v-for="p in ['work', 'short-break', 'long-break']"
          :key="p"
          class="phase-tab"
          :class="{ active: pomo.phase === p }"
          :style="pomo.phase === p ? { borderColor: PHASE_COLORS[p] } : {}"
        >
          {{ p === 'work' ? '专注 25min' : p === 'short-break' ? '短休 5min' : '长休 15min' }}
        </span>
      </div>

      <!-- Timer circle -->
      <div class="timer-wrap">
        <div class="timer-ring" :style="{ '--ring-color': PHASE_COLORS[pomo.phase] }">
          <div class="timer-inner">
            <div class="timer-display">{{ pomo.displayTime }}</div>
            <div class="timer-label">{{ pomo.phaseLabel }}</div>
          </div>
        </div>
      </div>

      <!-- Controls -->
      <div class="controls">
        <button v-if="pomo.phase === 'idle'" class="btn-start" @click="pomo.start()">
          开始专注
        </button>
        <template v-else>
          <button v-if="!pomo.running" class="btn-start" @click="pomo.running ? pomo.pause() : pomo.resume()">
            继续
          </button>
          <button v-if="pomo.running" class="btn-pause" @click="pomo.pause()">
            暂停
          </button>
          <button class="btn-skip" @click="pomo.skipToNext()">
            跳过
          </button>
          <button class="btn-stop" @click="pomo.resetToWork()">
            重置
          </button>
        </template>
      </div>

      <p class="shortcut-hint">空格键 — 开始 / 暂停</p>

      <!-- Stats -->
      <div class="stats-row">
        <div class="stat-item">
          <div class="stat-num">{{ pomo.completedCount }}</div>
          <div class="stat-lbl">本次番茄</div>
        </div>
        <div class="stat-item">
          <div class="stat-num">{{ pomo.totalCompleted }}</div>
          <div class="stat-lbl">累计番茄</div>
        </div>
        <div class="stat-item">
          <div class="stat-num">{{ ach.unlockedCount() }}/{{ ach.totalCount() }}</div>
          <div class="stat-lbl">已解锁成就</div>
        </div>
      </div>
    </div>

    <!-- Achievement unlock toast -->
    <transition-group name="toast" tag="div" class="toast-stack">
      <div v-for="a in ach.newlyUnlocked" :key="a.id" class="toast-item" @click="ach.clearNewlyUnlocked()">
        <span class="toast-icon">{{ a.icon }}</span>
        <div class="toast-body">
          <div class="toast-title">成就解锁！{{ a.title }}</div>
          <div class="toast-desc">{{ a.desc }}</div>
        </div>
      </div>
    </transition-group>

    <!-- Tips section -->
    <div class="tips-card">
      <h3 class="tips-title">番茄工作法</h3>
      <ul class="tips-list">
        <li>选择一项任务，专注工作 25 分钟，期间不受任何打扰</li>
        <li>工作结束后休息 5 分钟，每 4 个番茄后享受 15 分钟长休息</li>
        <li>将大任务拆解为若干个番茄，记录完成情况</li>
        <li>如被打断，重新计时，保证每个番茄的完整性</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.pomo-view { max-width: 600px; display: flex; flex-direction: column; gap: 24px; }
.page-title { font-size: 22px; font-weight: 700; color: #e2e8f0; }

.pomo-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 16px;
  padding: 32px; display: flex; flex-direction: column; align-items: center; gap: 24px;
}

.phase-tabs { display: flex; gap: 8px; }
.phase-tab {
  padding: 6px 14px; border-radius: 20px; border: 1px solid #475569;
  font-size: 12px; color: #94a3b8; transition: all 0.2s;
}
.phase-tab.active { color: #e2e8f0; border-width: 2px; }

.timer-wrap { position: relative; }
.timer-ring {
  width: 220px; height: 220px; border-radius: 50%;
  border: 6px solid var(--ring-color, #475569);
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.4s;
  box-shadow: 0 0 32px color-mix(in srgb, var(--ring-color, #475569) 30%, transparent);
}
.timer-inner { text-align: center; }
.timer-display { font-size: 56px; font-weight: 700; color: #e2e8f0; letter-spacing: -2px; font-variant-numeric: tabular-nums; }
.timer-label { font-size: 13px; color: #94a3b8; margin-top: 4px; }

.controls { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
.btn-start {
  background: #dc2626; border: none; border-radius: 10px; color: #fff;
  padding: 12px 32px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.btn-start:hover { background: #b91c1c; }
.btn-pause {
  background: #d97706; border: none; border-radius: 10px; color: #fff;
  padding: 12px 24px; font-size: 15px; cursor: pointer;
}
.btn-pause:hover { background: #b45309; }
.btn-skip {
  background: none; border: 1px solid #475569; border-radius: 10px; color: #94a3b8;
  padding: 12px 20px; font-size: 14px; cursor: pointer;
}
.btn-skip:hover { border-color: #94a3b8; color: #e2e8f0; }
.btn-stop {
  background: none; border: 1px solid #475569; border-radius: 10px; color: #64748b;
  padding: 12px 20px; font-size: 14px; cursor: pointer;
}
.btn-stop:hover { border-color: #94a3b8; color: #94a3b8; }

.shortcut-hint { font-size: 11px; color: #475569; }

.stats-row { display: flex; gap: 32px; }
.stat-item { text-align: center; }
.stat-num { font-size: 28px; font-weight: 700; color: #e2e8f0; }
.stat-lbl { font-size: 11px; color: #64748b; margin-top: 2px; }

/* Toast */
.toast-stack { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column; gap: 10px; z-index: 999; }
.toast-item {
  display: flex; align-items: center; gap: 12px;
  background: #1e293b; border: 1px solid #22c55e; border-radius: 12px;
  padding: 12px 16px; cursor: pointer; min-width: 260px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.toast-icon { font-size: 28px; }
.toast-title { font-size: 13px; font-weight: 700; color: #e2e8f0; }
.toast-desc { font-size: 12px; color: #94a3b8; margin-top: 2px; }
.toast-enter-active { animation: slideIn 0.3s ease; }
.toast-leave-active { animation: slideIn 0.3s ease reverse; }
@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

/* Tips */
.tips-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
.tips-title { font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; }
.tips-list { padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
.tips-list li { font-size: 13px; color: #64748b; }
</style>
