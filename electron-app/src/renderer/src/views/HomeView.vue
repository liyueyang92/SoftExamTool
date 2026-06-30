<script setup lang="ts">
import { onMounted, computed } from 'vue'
import { useAppStore } from '../stores/app'
import { useTaskStore } from '../stores/task'
import { usePlanStore } from '../stores/plan'
import { useRouter } from 'vue-router'

const app = useAppStore()
const tasks = useTaskStore()
const plan = usePlanStore()
const router = useRouter()

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const topTagAccuracy = computed(() =>
  plan.stats?.tagAccuracy.slice(0, 3) ?? []
)

onMounted(async () => {
  await plan.loadPlan()
})
</script>

<template>
  <div class="home">
    <!-- Exam countdown (if plan exists) -->
    <div v-if="plan.activePlan" class="exam-banner">
      <div class="exam-countdown">
        <span class="days-num">{{ plan.examDaysLeft }}</span>
        <span class="days-label">天后考试</span>
      </div>
      <div class="exam-info">
        <div class="exam-date">考试日期：{{ plan.activePlan.exam_date }}</div>
        <div class="exam-mode">
          <span class="mode-chip" :class="plan.activePlan.mode">
            {{ plan.activePlan.mode === 'sprint' ? '🚀 冲刺模式' : '📚 全面备考' }}
          </span>
        </div>
      </div>
      <div class="today-summary">
        <div class="today-num">{{ plan.todayProgress.completed }}/{{ plan.todayProgress.total }}</div>
        <div class="today-lbl">今日任务完成</div>
        <div class="today-bar-wrap">
          <div class="today-bar" :style="{ width: plan.todayProgress.pct + '%' }" />
        </div>
      </div>
      <button class="goto-plans" @click="router.push('/plans')">查看学习计划 →</button>
    </div>

    <!-- No plan hint -->
    <div v-else class="no-plan-hint">
      <span>📅</span>
      <span>还没有学习计划，</span>
      <button class="link-btn" @click="router.push('/plans')">立即制定 →</button>
    </div>

    <!-- System status cards -->
    <h2 class="section-title">系统状态</h2>
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

      <template v-if="plan.stats">
        <div class="card">
          <div class="card-label">连续打卡</div>
          <div class="card-value">{{ plan.stats.streak }} 天</div>
        </div>
        <div class="card">
          <div class="card-label">今日学习</div>
          <div class="card-value">{{ formatMs(plan.stats.todayStudyMs) }}</div>
        </div>
      </template>
    </div>

    <!-- Task progress section -->
    <div v-if="tasks.progressMap.size > 0" class="progress-section">
      <h2 class="section-title">任务进度</h2>
      <div v-for="[id, p] in tasks.progressMap" :key="id" class="progress-item">
        <span class="task-id">{{ id.slice(0, 8) }}…</span>
        <div class="bar-wrap">
          <div class="bar" :style="{ width: p.progress + '%' }" />
        </div>
        <span class="pct">{{ p.progress }}%</span>
        <span class="msg">{{ p.message }}</span>
      </div>
    </div>

    <!-- Weak knowledge points -->
    <div v-if="topTagAccuracy.length > 0" class="weak-section">
      <h2 class="section-title">
        薄弱知识点
        <span class="hint-sm">（正确率最低的 3 个）</span>
      </h2>
      <div class="weak-list">
        <div v-for="tag in topTagAccuracy" :key="tag.tag" class="weak-item">
          <span class="weak-tag">{{ tag.tag }}</span>
          <div class="weak-bar-wrap">
            <div
              class="weak-bar"
              :class="tag.rate < 0.6 ? 'low' : 'mid'"
              :style="{ width: Math.round(tag.rate * 100) + '%' }"
            />
          </div>
          <span class="weak-pct" :class="tag.rate < 0.6 ? 'low' : 'mid'">
            {{ Math.round(tag.rate * 100) }}%
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home { max-width: 860px; padding-bottom: 40px; }

/* Exam banner */
.exam-banner {
  display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
  background: linear-gradient(135deg, #1e3a5f 0%, #1e293b 100%);
  border: 1px solid #2563eb; border-radius: 14px; padding: 20px 24px; margin-bottom: 28px;
}
.exam-countdown { text-align: center; min-width: 80px; }
.days-num { font-size: 52px; font-weight: 800; color: #3b82f6; line-height: 1; display: block; }
.days-label { font-size: 12px; color: #64748b; display: block; }
.exam-info { flex: 1; min-width: 140px; }
.exam-date { font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
.mode-chip {
  font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 99px;
  background: #1e3a5f; color: #60a5fa;
}
.mode-chip.sprint { background: #3b1e1e; color: #f87171; }
.today-summary { text-align: center; min-width: 100px; }
.today-num { font-size: 20px; font-weight: 700; color: #22c55e; }
.today-lbl { font-size: 11px; color: #64748b; margin-bottom: 6px; }
.today-bar-wrap { width: 80px; height: 5px; background: #0f172a; border-radius: 3px; overflow: hidden; }
.today-bar { height: 100%; background: #22c55e; border-radius: 3px; transition: width 0.4s; }
.goto-plans {
  background: #3b82f6; color: #fff; border: none; border-radius: 8px;
  padding: 8px 16px; font-size: 13px; cursor: pointer; font-weight: 600; white-space: nowrap;
}
.goto-plans:hover { background: #2563eb; }

/* No plan hint */
.no-plan-hint {
  display: flex; align-items: center; gap: 8px; font-size: 14px; color: #64748b;
  background: #1e293b; border: 1px dashed #334155; border-radius: 10px;
  padding: 16px 20px; margin-bottom: 28px;
}
.link-btn {
  background: none; border: none; color: #3b82f6; cursor: pointer; font-size: 14px; padding: 0;
}
.link-btn:hover { text-decoration: underline; }

/* Section titles */
.section-title {
  font-size: 14px; font-weight: 600; color: #94a3b8; margin-bottom: 12px;
  display: flex; align-items: center; gap: 8px;
}
.hint-sm { font-size: 12px; font-weight: 400; color: #475569; }

/* Status cards */
.cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 28px; }
.card {
  padding: 14px 18px; border-radius: 10px; background: #1e293b;
  border: 1px solid #334155; min-width: 120px;
}
.card.ok   { border-color: #166534; }
.card.warn { border-color: #854d0e; }
.card-label { font-size: 11px; color: #64748b; margin-bottom: 4px; }
.card-value { font-size: 18px; font-weight: 600; color: #e2e8f0; }

/* Task progress */
.progress-section { margin-bottom: 28px; }
.progress-item {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 0; border-bottom: 1px solid #1e293b;
}
.task-id { font-family: monospace; font-size: 12px; color: #64748b; width: 80px; }
.bar-wrap { flex: 1; height: 6px; background: #1e293b; border-radius: 3px; overflow: hidden; }
.bar { height: 100%; background: #3b82f6; border-radius: 3px; transition: width 0.3s; }
.pct { font-size: 12px; width: 36px; text-align: right; color: #94a3b8; }
.msg { font-size: 12px; color: #64748b; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

/* Weak section */
.weak-section { margin-bottom: 28px; }
.weak-list { display: flex; flex-direction: column; gap: 8px; }
.weak-item { display: flex; align-items: center; gap: 12px; }
.weak-tag { width: 160px; font-size: 13px; color: #94a3b8; flex-shrink: 0; }
.weak-bar-wrap { flex: 1; height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden; }
.weak-bar { height: 100%; border-radius: 3px; }
.weak-bar.low { background: #ef4444; }
.weak-bar.mid { background: #3b82f6; }
.weak-pct { width: 40px; text-align: right; font-size: 12px; font-weight: 600; }
.weak-pct.low { color: #ef4444; }
.weak-pct.mid { color: #3b82f6; }
</style>
