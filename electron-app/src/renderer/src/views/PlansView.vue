<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { usePlanStore } from '../stores/plan'
import type { PlanTask } from '../stores/plan'

const plan = usePlanStore()

// Setup form
const examDate = ref('')
const planMode = ref<'normal' | 'sprint'>('normal')
const creating = ref(false)

// Calendar view
const calYear = ref(new Date().getFullYear())
const calMonth = ref(new Date().getMonth() + 1)
const showCalendar = ref(false)

// Adapt panel
const showAdapt = ref(false)
const adapting = ref(false)

// Session timer
const sessionStartTime = ref<number | null>(null)
const sessionElapsed = ref(0)
let timerInterval: ReturnType<typeof setInterval> | null = null

const minExamDate = computed(() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
})

const calendarDayMap = computed(() => {
  const map: Record<string, { total: number; completed: number }> = {}
  for (const d of plan.calendarData) {
    map[d.date] = { total: d.total, completed: d.completed }
  }
  return map
})

const calendarGrid = computed(() => {
  const firstDay = new Date(calYear.value, calMonth.value - 1, 1)
  const lastDay = new Date(calYear.value, calMonth.value, 0)
  const startOffset = firstDay.getDay() // 0=Sun
  const grid: Array<{ date: string; day: number; status: string } | null> = []
  for (let i = 0; i < startOffset; i++) grid.push(null)
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = `${calYear.value}-${String(calMonth.value).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const info = calendarDayMap.value[dateStr]
    let status = 'empty'
    if (info) {
      if (info.completed === info.total) status = 'done'
      else if (info.completed > 0) status = 'partial'
      else status = 'pending'
    }
    grid.push({ date: dateStr, day: d, status })
  }
  return grid
})

const todayStr = new Date().toISOString().slice(0, 10)

const sessionElapsedDisplay = computed(() => {
  const s = Math.floor(sessionElapsed.value / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
})

function statusIcon(task: PlanTask): string {
  if (task.status === 'completed') return '✓'
  if (task.status === 'in_progress') return '▶'
  return '○'
}

function statusClass(task: PlanTask): string {
  return `status-${task.status}`
}

function formatMs(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function prevMonth(): void {
  if (calMonth.value === 1) { calMonth.value = 12; calYear.value-- }
  else calMonth.value--
  loadCalendar()
}

function nextMonth(): void {
  if (calMonth.value === 12) { calMonth.value = 1; calYear.value++ }
  else calMonth.value++
  loadCalendar()
}

async function loadCalendar(): Promise<void> {
  await plan.loadCalendar(calYear.value, calMonth.value)
}

async function handleCreate(): Promise<void> {
  if (!examDate.value) return
  creating.value = true
  await plan.createPlan(examDate.value, planMode.value)
  creating.value = false
  if (plan.activePlan) {
    await loadCalendar()
    await plan.loadSessions()
  }
}

async function handleAdapt(): Promise<void> {
  adapting.value = true
  await plan.runAdapt()
  adapting.value = false
  showAdapt.value = true
}

function startTimer(): void {
  sessionStartTime.value = Date.now()
  sessionElapsed.value = 0
  timerInterval = setInterval(() => {
    if (sessionStartTime.value) {
      sessionElapsed.value = Date.now() - sessionStartTime.value
    }
  }, 1000)
  plan.beginSession()
}

async function stopTimer(): Promise<void> {
  if (!plan.runningSession) return
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
  const durationMs = sessionStartTime.value ? Date.now() - sessionStartTime.value : 0
  sessionStartTime.value = null
  await plan.finishSession(plan.runningSession.id, durationMs)
}

watch(showCalendar, (val) => {
  if (val) loadCalendar()
})

onMounted(async () => {
  await plan.loadPlan()
  if (plan.activePlan) {
    await Promise.all([loadCalendar(), plan.loadSessions()])
  }
})
</script>

<template>
  <div class="plans">
    <!-- ── No plan: Setup form ──────────────────── -->
    <div v-if="!plan.activePlan" class="setup-panel">
      <div class="setup-card">
        <div class="setup-icon">📅</div>
        <h1>制定学习计划</h1>
        <p class="setup-desc">输入考试日期，系统将根据官方大纲自动生成每日学习安排</p>

        <div class="form-row">
          <label>考试日期</label>
          <input v-model="examDate" type="date" :min="minExamDate" class="date-input" />
        </div>

        <div class="form-row">
          <label>备考模式</label>
          <div class="mode-select">
            <button
              :class="['mode-btn', planMode === 'normal' ? 'active' : '']"
              @click="planMode = 'normal'"
            >
              <span class="mode-icon">📚</span>
              <span class="mode-name">全面备考</span>
              <span class="mode-desc">系统学习所有知识点，适合距考试 30 天以上</span>
            </button>
            <button
              :class="['mode-btn', planMode === 'sprint' ? 'active' : '']"
              @click="planMode = 'sprint'"
            >
              <span class="mode-icon">🚀</span>
              <span class="mode-name">冲刺模式</span>
              <span class="mode-desc">专攻案例与论文，适合距考试 30 天以内</span>
            </button>
          </div>
        </div>

        <button
          class="btn-primary create-btn"
          :disabled="!examDate || creating"
          @click="handleCreate"
        >
          {{ creating ? '生成中…' : '生成学习计划' }}
        </button>
      </div>
    </div>

    <!-- ── Has plan: Main dashboard ────────────── -->
    <template v-else>
      <!-- Header -->
      <div class="plan-header">
        <div class="plan-meta">
          <span class="badge" :class="plan.activePlan.mode">
            {{ plan.activePlan.mode === 'sprint' ? '🚀 冲刺模式' : '📚 全面备考' }}
          </span>
          <span class="exam-date-label">考试日期：{{ plan.activePlan.exam_date }}</span>
        </div>
        <div class="header-actions">
          <button class="btn-ghost btn-sm" @click="handleAdapt" :disabled="adapting">
            {{ adapting ? '分析中…' : '⚡ 自适应调整' }}
          </button>
          <button class="btn-ghost btn-sm danger" @click="plan.deletePlan">删除计划</button>
        </div>
      </div>

      <!-- Countdown + Session timer -->
      <div class="top-row">
        <div class="countdown-card">
          <div class="countdown-num">{{ plan.examDaysLeft }}</div>
          <div class="countdown-label">天后考试</div>
          <div class="today-progress-bar">
            <div
              class="progress-fill"
              :style="{ width: plan.todayProgress.pct + '%' }"
            />
          </div>
          <div class="today-progress-text">
            今日完成 {{ plan.todayProgress.completed }} / {{ plan.todayProgress.total }} 个任务
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-val">{{ plan.stats?.streak ?? 0 }}</div>
            <div class="stat-lbl">连续打卡（天）</div>
          </div>
          <div class="stat-card">
            <div class="stat-val">{{ plan.stats ? formatMs(plan.stats.todayStudyMs) : '0m' }}</div>
            <div class="stat-lbl">今日学习时长</div>
          </div>
          <div class="stat-card">
            <div class="stat-val">{{ plan.stats ? formatMs(plan.stats.totalStudyMs) : '0m' }}</div>
            <div class="stat-lbl">累计学习时长</div>
          </div>
          <div class="stat-card session-card">
            <template v-if="!plan.runningSession">
              <button class="btn-primary btn-sm" @click="startTimer">开始学习计时</button>
            </template>
            <template v-else>
              <div class="stat-val timer-val">{{ sessionElapsedDisplay }}</div>
              <div class="stat-lbl">当前学习中</div>
              <button class="btn-ghost btn-sm" @click="stopTimer">结束</button>
            </template>
          </div>
        </div>
      </div>

      <!-- Today's tasks -->
      <section class="section">
        <h2 class="section-title">今日任务 <span class="date-badge">{{ todayStr }}</span></h2>

        <div v-if="plan.todayTasks.length === 0" class="empty-hint">
          今日没有安排任务，好好休息！
        </div>

        <div v-else class="task-list">
          <div
            v-for="task in plan.todayTasks"
            :key="task.id"
            class="task-item"
            :class="statusClass(task)"
          >
            <span class="task-status-icon" :class="statusClass(task)">{{ statusIcon(task) }}</span>
            <div class="task-body">
              <span class="task-tag">{{ task.knowledge_tag }}</span>
              <span class="task-count">建议 {{ task.suggested_count }} 题</span>
            </div>
            <div class="task-actions">
              <button
                v-if="task.status === 'pending'"
                class="btn-ghost btn-xs"
                @click="plan.startTaskProgress(task.id)"
              >开始</button>
              <button
                v-if="task.status !== 'completed'"
                class="btn-primary btn-xs"
                @click="plan.completeTask(task.id)"
              >完成</button>
              <span v-else class="done-label">已完成</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Calendar toggle -->
      <section class="section">
        <div class="section-header" @click="showCalendar = !showCalendar" style="cursor:pointer">
          <h2 class="section-title">
            学习日历
            <span class="toggle-arrow">{{ showCalendar ? '▲' : '▼' }}</span>
          </h2>
        </div>

        <div v-if="showCalendar" class="calendar-wrap">
          <div class="cal-nav">
            <button class="btn-ghost btn-xs" @click="prevMonth">‹</button>
            <span class="cal-title">{{ calYear }}年 {{ calMonth }}月</span>
            <button class="btn-ghost btn-xs" @click="nextMonth">›</button>
          </div>
          <div class="cal-grid">
            <div v-for="h in ['日','一','二','三','四','五','六']" :key="h" class="cal-head">{{ h }}</div>
            <div
              v-for="(cell, i) in calendarGrid"
              :key="i"
              class="cal-cell"
              :class="[cell ? `cal-${cell.status}` : 'cal-empty', cell?.date === todayStr ? 'cal-today' : '']"
            >
              <span v-if="cell">{{ cell.day }}</span>
            </div>
          </div>
          <div class="cal-legend">
            <span class="leg-item"><span class="leg-dot cal-done" />全部完成</span>
            <span class="leg-item"><span class="leg-dot cal-partial" />部分完成</span>
            <span class="leg-item"><span class="leg-dot cal-pending" />未完成</span>
          </div>
        </div>
      </section>

      <!-- Knowledge accuracy -->
      <section v-if="plan.stats?.tagAccuracy.length" class="section">
        <h2 class="section-title">知识点正确率</h2>
        <div class="accuracy-list">
          <div
            v-for="tag in plan.stats.tagAccuracy"
            :key="tag.tag"
            class="accuracy-row"
          >
            <span class="acc-tag">{{ tag.tag }}</span>
            <div class="acc-bar-wrap">
              <div
                class="acc-bar"
                :class="tag.rate < 0.6 ? 'low' : tag.rate > 0.9 ? 'high' : 'mid'"
                :style="{ width: Math.round(tag.rate * 100) + '%' }"
              />
            </div>
            <span class="acc-pct" :class="tag.rate < 0.6 ? 'low' : tag.rate > 0.9 ? 'high' : 'mid'">
              {{ Math.round(tag.rate * 100) }}%
            </span>
            <span class="acc-count">{{ tag.total }} 题</span>
          </div>
        </div>
      </section>

      <!-- Adaptive adjustment results -->
      <section v-if="showAdapt" class="section adapt-section">
        <h2 class="section-title">⚡ 自适应调整结果</h2>
        <div v-if="plan.adaptAdjustments.length === 0" class="empty-hint">
          当前数据不足以生成调整建议（每个知识点需至少 5 道答题记录）。
        </div>
        <div v-else class="adjust-list">
          <div
            v-for="adj in plan.adaptAdjustments"
            :key="adj.tag"
            class="adjust-item"
            :class="adj.change > 0 ? 'increase' : 'decrease'"
          >
            <span class="adj-tag">{{ adj.tag }}</span>
            <span class="adj-change">{{ adj.change > 0 ? `+${adj.change}` : adj.change }} 题/天</span>
            <span class="adj-reason">{{ adj.reason }}</span>
          </div>
        </div>
        <button class="btn-ghost btn-sm" @click="showAdapt = false">收起</button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.plans { max-width: 860px; padding-bottom: 40px; }

/* ── Setup form ── */
.setup-panel { display: flex; justify-content: center; padding-top: 60px; }
.setup-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 16px;
  padding: 40px 48px; max-width: 520px; width: 100%; text-align: center;
}
.setup-icon { font-size: 48px; margin-bottom: 16px; }
.setup-card h1 { font-size: 22px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px; }
.setup-desc { font-size: 13px; color: #64748b; margin-bottom: 28px; }
.form-row { text-align: left; margin-bottom: 20px; }
.form-row label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
.date-input {
  width: 100%; padding: 9px 12px; background: #0f172a; border: 1px solid #334155;
  border-radius: 8px; color: #e2e8f0; font-size: 14px; box-sizing: border-box;
  color-scheme: dark;
}
.mode-select { display: flex; gap: 10px; }
.mode-btn {
  flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 12px 14px; background: #0f172a; border: 1px solid #334155; border-radius: 8px;
  cursor: pointer; text-align: left; transition: border-color 0.15s;
}
.mode-btn.active { border-color: #3b82f6; background: #1e3a5f; }
.mode-btn:hover:not(.active) { border-color: #475569; }
.mode-icon { font-size: 20px; }
.mode-name { font-size: 13px; font-weight: 600; color: #e2e8f0; }
.mode-desc { font-size: 11px; color: #64748b; line-height: 1.3; }
.create-btn { width: 100%; margin-top: 8px; }

/* ── Plan header ── */
.plan-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #1e293b;
}
.plan-meta { display: flex; align-items: center; gap: 12px; }
.badge {
  font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 99px;
  background: #1e3a5f; color: #60a5fa;
}
.badge.sprint { background: #3b1e1e; color: #f87171; }
.exam-date-label { font-size: 13px; color: #64748b; }
.header-actions { display: flex; gap: 8px; }

/* ── Top row ── */
.top-row { display: flex; gap: 16px; margin-bottom: 24px; }
.countdown-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 12px;
  padding: 24px 28px; min-width: 180px; text-align: center;
}
.countdown-num { font-size: 64px; font-weight: 800; color: #3b82f6; line-height: 1; }
.countdown-label { font-size: 13px; color: #64748b; margin-top: 4px; margin-bottom: 16px; }
.today-progress-bar {
  height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden; margin-bottom: 6px;
}
.progress-fill { height: 100%; background: #22c55e; border-radius: 3px; transition: width 0.4s; }
.today-progress-text { font-size: 11px; color: #94a3b8; }

.stats-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.stat-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 10px;
  padding: 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
}
.stat-val { font-size: 22px; font-weight: 700; color: #e2e8f0; }
.timer-val { font-size: 20px; font-family: monospace; color: #22c55e; }
.stat-lbl { font-size: 11px; color: #64748b; }
.session-card { gap: 8px; }

/* ── Section ── */
.section { margin-bottom: 28px; }
.section-header { display: flex; justify-content: space-between; align-items: center; }
.section-title {
  font-size: 15px; font-weight: 600; color: #cbd5e1; margin-bottom: 14px;
  display: flex; align-items: center; gap: 8px;
}
.date-badge {
  font-size: 11px; font-weight: 400; color: #475569; background: #1e293b;
  padding: 2px 8px; border-radius: 4px;
}
.toggle-arrow { font-size: 12px; color: #475569; }

/* ── Task list ── */
.task-list { display: flex; flex-direction: column; gap: 8px; }
.task-item {
  display: flex; align-items: center; gap: 12px;
  background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px;
}
.task-item.status-completed { opacity: 0.6; }
.task-status-icon { font-size: 16px; width: 20px; text-align: center; }
.task-status-icon.status-completed { color: #22c55e; }
.task-status-icon.status-in_progress { color: #f59e0b; }
.task-status-icon.status-pending { color: #475569; }
.task-body { flex: 1; }
.task-tag { font-size: 14px; color: #e2e8f0; font-weight: 500; }
.task-count { font-size: 12px; color: #64748b; margin-left: 8px; }
.task-actions { display: flex; gap: 6px; align-items: center; }
.done-label { font-size: 12px; color: #22c55e; }
.empty-hint { font-size: 13px; color: #475569; padding: 20px 0; }

/* ── Calendar ── */
.calendar-wrap { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 20px; }
.cal-nav { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 16px; }
.cal-title { font-size: 14px; font-weight: 600; color: #e2e8f0; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.cal-head { text-align: center; font-size: 11px; color: #475569; padding: 4px 0; }
.cal-cell {
  aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
  border-radius: 6px; font-size: 12px; color: #475569; cursor: default;
}
.cal-empty { background: transparent; }
.cal-done { background: #166534; color: #4ade80; }
.cal-partial { background: #78350f; color: #fbbf24; }
.cal-pending { background: #1e293b; color: #64748b; }
.cal-today { outline: 2px solid #3b82f6; }
.cal-legend { display: flex; gap: 16px; margin-top: 12px; justify-content: center; }
.leg-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #64748b; }
.leg-dot {
  width: 12px; height: 12px; border-radius: 3px; display: inline-block;
}

/* ── Accuracy ── */
.accuracy-list { display: flex; flex-direction: column; gap: 8px; }
.accuracy-row { display: flex; align-items: center; gap: 12px; }
.acc-tag { width: 160px; font-size: 13px; color: #94a3b8; flex-shrink: 0; }
.acc-bar-wrap { flex: 1; height: 6px; background: #0f172a; border-radius: 3px; overflow: hidden; }
.acc-bar { height: 100%; border-radius: 3px; transition: width 0.4s; }
.acc-bar.low  { background: #ef4444; }
.acc-bar.mid  { background: #3b82f6; }
.acc-bar.high { background: #22c55e; }
.acc-pct { width: 40px; text-align: right; font-size: 12px; font-weight: 600; }
.acc-pct.low  { color: #ef4444; }
.acc-pct.mid  { color: #3b82f6; }
.acc-pct.high { color: #22c55e; }
.acc-count { font-size: 11px; color: #475569; width: 46px; text-align: right; }

/* ── Adapt section ── */
.adapt-section { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 16px 20px; }
.adjust-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.adjust-item {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px; border-radius: 6px; font-size: 13px;
}
.adjust-item.increase { background: #172d20; border-left: 3px solid #22c55e; }
.adjust-item.decrease { background: #2d1a17; border-left: 3px solid #f59e0b; }
.adj-tag { flex: 0 0 160px; color: #e2e8f0; }
.adj-change { flex: 0 0 70px; font-weight: 600; }
.adjust-item.increase .adj-change { color: #22c55e; }
.adjust-item.decrease .adj-change { color: #f59e0b; }
.adj-reason { color: #64748b; font-size: 12px; }

/* ── Buttons ── */
.btn-primary {
  background: #3b82f6; color: #fff; border: none; border-radius: 6px;
  padding: 8px 18px; font-size: 13px; cursor: pointer; font-weight: 600; transition: background 0.15s;
}
.btn-primary:hover { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost {
  background: transparent; color: #94a3b8; border: 1px solid #334155; border-radius: 6px;
  padding: 6px 14px; font-size: 13px; cursor: pointer; transition: border-color 0.15s;
}
.btn-ghost:hover { border-color: #64748b; color: #e2e8f0; }
.btn-ghost.danger:hover { border-color: #ef4444; color: #ef4444; }
.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 5px 12px; font-size: 12px; }
.btn-xs { padding: 3px 10px; font-size: 11px; }
</style>
