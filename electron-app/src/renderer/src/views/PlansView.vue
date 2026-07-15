<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePlanStore } from '../stores/plan'
import type { PlanTask } from '../stores/plan'

import { useKnowledgeDomainStore } from '../stores/knowledge-domain'

const plan = usePlanStore()
const router = useRouter()
const domainStore = useKnowledgeDomainStore()

// Setup form
const examDate = ref('')
const planMode = ref<'normal' | 'sprint'>('normal')
const creating = ref(false)
const aiGenerating = ref(false)
const dailyHours = ref(2)
const aiError = ref('')
const aiOptimizing = ref(false)

// Calendar view
const calYear = ref(new Date().getFullYear())
const calMonth = ref(new Date().getMonth() + 1)
const showCalendar = ref(false)

// Adapt panel
const showAdapt = ref(false)
const adapting = ref(false)

// Doc relink
const relinking = ref(false)

// Session timer
const sessionStartTime = ref<number | null>(null)
const sessionElapsed = ref(0)
let timerInterval: ReturnType<typeof setInterval> | null = null

// Document title lookup (doc_id → title)
const docTitleMap = ref<Map<string, string>>(new Map())
const docsLoaded = ref(false)

const minExamDate = computed(() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
})

// ── Task display helpers ──────────────────────────────────────────────────

/** 任务类型 → 短标签 */
function taskTypeShort(type?: string): string {
  const map: Record<string, string> = {
    reading: '阅读',
    video: '视频',
    practice: '练习',
    review: '复习',
    essay: '论文',
    mock_exam: '模考',
    custom: '自定义',
  }
  return map[type ?? 'practice'] ?? '练习'
}

/** 根据任务状态返回图标 */
function statusIcon(task: PlanTask): string {
  if (task.status === 'completed') return '✓'
  if (task.status === 'in_progress') return '▶'
  return '○'
}

/** 任务状态 → CSS class */
function statusClass(task: PlanTask): string {
  return `status-${task.status}`
}

/** 查找文档标题（优先 docTitleMap，降级用 backupTitle） */
function getDocTitle(docId?: string | null, backupTitle?: string): string {
  if (!docId) return ''
  return docTitleMap.value.get(docId) ?? backupTitle ?? ''
}

/** 从 linked_question_ids 中提取题目数量 */
function getQuestionCount(task: PlanTask): number {
  if (!task.linked_question_ids) return 0
  try {
    const arr = JSON.parse(task.linked_question_ids)
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return 0
  }
}

/** 解析 linked_doc_ids JSON，返回关联文档列表 */
interface LinkedDoc {
  doc_id: string
  page_range: string
  title?: string
  chunk_count?: number
  is_official?: number
}
function getLinkedDocs(task: PlanTask): LinkedDoc[] {
  // 优先使用 linked_doc_ids（多文档）
  if (task.linked_doc_ids) {
    try {
      const arr = JSON.parse(task.linked_doc_ids)
      if (Array.isArray(arr) && arr.length > 0) return arr as LinkedDoc[]
    } catch { /* ignore */ }
  }
  // 降级：使用单 doc_id/doc_page_range 构造一项
  if (task.doc_id) {
    return [{ doc_id: task.doc_id, page_range: task.doc_page_range ?? '' }]
  }
  return []
}

/** 加载文档列表，构建 doc_id → title 映射 */
async function loadDocuments(): Promise<void> {
  if (docsLoaded.value) return
  try {
    const res = await window.electronAPI.listDocuments()
    if (res.success && Array.isArray(res.data)) {
      const map = new Map<string, string>()
      for (const doc of res.data as Array<{ id: string; title: string }>) {
        map.set(doc.id, doc.title)
      }
      docTitleMap.value = map
    }
    docsLoaded.value = true
  } catch {
    // 文档列表加载失败不影响计划视图
  }
}

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

// ── View mode: today vs all-list ───────────────────────────────────────────

const viewMode = ref<'today' | 'list'>('today')

/** 按日期分组 allTasks，并统计每天进度 */
const groupedTasks = computed(() => {
  if (plan.allTasks.length === 0) return [] as Array<{ date: string; tasks: PlanTask[]; completed: number; total: number }>
  const groups = new Map<string, PlanTask[]>()
  for (const task of plan.allTasks) {
    const list = groups.get(task.date) ?? []
    list.push(task)
    groups.set(task.date, list)
  }
  return Array.from(groups.entries())
    .map(([date, tasks]) => ({
      date,
      tasks,
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
})

/** 生成日期的"内容签名"——由知识点标签 + 任务类型决定 */
function daySignature(tasks: PlanTask[]): string {
  const tags = [...new Set(tasks.map((t) => `${t.knowledge_tag}|${t.task_type || 'practice'}`))]
  tags.sort()
  return tags.join('::')
}

/** 合并连续相同内容日期的精简分组 */
interface CondensedGroup {
  dateFrom: string
  dateTo: string
  tags: string[]
  tasks: PlanTask[]
  total: number
  completed: number
}

const condensedGroups = computed(() => {
  if (groupedTasks.value.length === 0) return [] as CondensedGroup[]
  const result: CondensedGroup[] = []
  let batch: typeof groupedTasks.value = []
  for (const day of groupedTasks.value) {
    if (batch.length === 0) {
      batch.push(day)
    } else if (daySignature(day.tasks) === daySignature(batch[0].tasks)) {
      batch.push(day)
    } else {
      result.push(makeCondensed(batch))
      batch = [day]
    }
  }
  if (batch.length) result.push(makeCondensed(batch))
  return result
})

function makeCondensed(batch: typeof groupedTasks.value): CondensedGroup {
  const allTasks = batch.flatMap((d) => d.tasks)
  const tags = [...new Set(allTasks.map((t) => t.knowledge_tag))]
  tags.sort()
  return {
    dateFrom: batch[0].date,
    dateTo: batch[batch.length - 1].date,
    tags,
    tasks: allTasks,
    total: allTasks.length,
    completed: allTasks.filter((t) => t.status === 'completed').length,
  }
}

/** 展开/收起状态 */
const expandedGroups = ref<Set<string>>(new Set())

function toggleGroup(dateFrom: string): void {
  const s = new Set(expandedGroups.value)
  if (s.has(dateFrom)) s.delete(dateFrom)
  else s.add(dateFrom)
  expandedGroups.value = s
}

function isGroupExpanded(dateFrom: string): boolean {
  return expandedGroups.value.has(dateFrom)
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function dayCount(cg: CondensedGroup): number {
  const from = new Date(cg.dateFrom + 'T00:00:00')
  const to = new Date(cg.dateTo + 'T00:00:00')
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1
}

/** 当天日期格式化（中文） */
function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekNames[d.getDay()]}`
}

// ── Date selection for calendar navigation ───────────────────────────────

/** 当前选中的日期（默认今天），点击日历格子可切换 */
const selectedDate = ref(todayStr)

/** 存放非今日日期的任务列表 */
const futureDateTasks = ref<PlanTask[]>([])

/** 当日历选中今天时直接复用 store.todayTasks，否则用独立加载的数据 */
const displayedTasks = computed<PlanTask[]>(() => {
  if (selectedDate.value === todayStr) return plan.todayTasks
  return futureDateTasks.value
})

/** 选中日期是否不是今天 */
const isViewingOtherDate = computed(() => selectedDate.value !== todayStr)

/** 点击日历日期 → 加载该日任务 */
async function selectDate(dateStr: string): Promise<void> {
  selectedDate.value = dateStr
  if (dateStr === todayStr) {
    // 切回今天直接用 store 中已有数据
    return
  }
  // 加载其他日期的任务
  await loadTasksForDate(dateStr)
}

/** 从后端加载指定日期的任务列表 */
async function loadTasksForDate(dateStr: string): Promise<void> {
  if (!plan.activePlan) return
  try {
    const res = await window.electronAPI.getPlanTasks({
      planId: plan.activePlan.id,
      dateFrom: dateStr,
      dateTo: dateStr,
    })
    if (res.success && Array.isArray(res.data)) {
      futureDateTasks.value = res.data as PlanTask[]
    }
  } catch {
    futureDateTasks.value = []
  }
}

/** 返回到今日视图 */
function backToToday(): void {
  selectDate(todayStr)
}

/** 刷新当前显示数据（含日历和全部任务） */
async function refreshCurrentView(): Promise<void> {
  await loadCalendar()
  if (selectedDate.value === todayStr) {
    await plan.loadTodayTasks()
    await plan.loadStats()
  } else {
    await loadTasksForDate(selectedDate.value)
  }
  // 列表视图需要刷新全部任务
  if (viewMode.value === 'list') {
    await plan.loadAllTasks()
  }
}

/** 开始任务 + 刷新 */
async function handleStartTask(taskId: string): Promise<void> {
  await plan.startTaskProgress(taskId)
  await refreshCurrentView()
}

/** 完成任务 + 刷新 */
async function handleCompleteTask(taskId: string): Promise<void> {
  await plan.completeTask(taskId)
  await refreshCurrentView()
}

const sessionElapsedDisplay = computed(() => {
  const s = Math.floor(sessionElapsed.value / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
})

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
    await Promise.all([loadCalendar(), plan.loadSessions(), loadDocuments(), plan.loadAllTasks()])
  }
}

/** 提取三级知识域列表 */
function extractDomains(): Array<{ name: string; weight_pct: number; suggested_min: number }> {
  const domains: Array<{ name: string; weight_pct: number; suggested_min: number }> = []
  for (const top of domainStore.tree) {
    for (const mid of top.children) {
      for (const leaf of mid.children) {
        domains.push({
          name: leaf.name,
          weight_pct: leaf.weight_pct,
          suggested_min: leaf.suggested_min,
        })
      }
    }
  }
  return domains
}

/** 确保知识域数据已加载 */
async function ensureDomainsLoaded(): Promise<void> {
  if (domainStore.tree.length === 0) {
    await domainStore.loadTree()
  }
}

/** AI 生成学习计划 */
async function handleAiCreate(): Promise<void> {
  if (!examDate.value) return
  aiError.value = ''
  aiGenerating.value = true
  try {
    await ensureDomainsLoaded()
    const domains = extractDomains()
    await plan.createPlanWithAi(examDate.value, planMode.value, dailyHours.value, domains, [])
    if (plan.activePlan) {
      await Promise.all([loadCalendar(), plan.loadSessions(), loadDocuments(), plan.loadAllTasks()])
    }
  } catch (e) {
    aiError.value = (e as Error).message
  } finally {
    aiGenerating.value = false
  }
}

/** AI 优化当前计划 */
async function handleAiOptimize(): Promise<void> {
  aiOptimizing.value = true
  try {
    await ensureDomainsLoaded()
    const domains = extractDomains().map((d) => ({ name: d.name, weight_pct: d.weight_pct }))
    await plan.optimizePlanWithAi(domains, dailyHours.value)
    await Promise.all([loadCalendar(), plan.loadSessions()])
  } catch (e) {
    alert('AI 优化失败：' + (e as Error).message)
  } finally {
    aiOptimizing.value = false
  }
}

async function handleAdapt(): Promise<void> {
  adapting.value = true
  await plan.runAdapt()
  adapting.value = false
  showAdapt.value = true
}

async function handleRelinkDocs(): Promise<void> {
  if (!plan.activePlan) return
  relinking.value = true
  try {
    // Step 1: remap old chunk tags to new naming convention
    const remapRes = await window.electronAPI.remapChunkTags()
    // Step 2: re-scan all tasks and link matching documents
    const relinkRes = await window.electronAPI.relinkPlanDocs(plan.activePlan.id)
    const updated = remapRes.success ? remapRes.data.updated : 0
    const linked = relinkRes.success ? relinkRes.data.linked : 0
    // Refresh display
    await Promise.all([plan.loadTodayTasks(), loadDocuments()])
    alert(`文档关联完成：\n- 更新标签映射 ${updated} 个\n- 关联任务 ${linked} 个`)
  } catch (e) {
    alert('关联失败：' + (e as Error).message)
  } finally {
    relinking.value = false
  }
}

/** 点击文档链接 → 跳转到文档库并自动打开该文档指定页 */
function openDocInLibrary(docId: string, pageRange?: string): void {
  const query: Record<string, string> = { docId }
  // 提取起始页码（"10-45" → 10）
  if (pageRange) {
    const match = pageRange.match(/^(\d+)/)
    if (match) query.page = match[1]
  }
  router.push({ name: 'documents', query })
}

/** 根据任务类型跳转到对应练习/阅读/写作页面 */
function goPractice(task: PlanTask): void {
  // 阅读任务 → 跳转关联文档
  if (task.task_type === 'reading') {
    const docs = getLinkedDocs(task)
    if (docs.length > 0) {
      openDocInLibrary(docs[0].doc_id, docs[0].page_range)
    }
    return
  }
  // 论文任务 → 跳转论文写作页
  if (task.task_type === 'essay') {
    router.push({ name: 'essay', query: { tag: task.knowledge_tag } })
    return
  }
  // 练习/复习/模考/自定义 → 跳转练习页，按知识点标签过滤
  router.push({ name: 'practice', query: { tag: task.knowledge_tag, count: String(task.suggested_count || 10) } })
}

/** 按钮文案 */
function practiceBtnLabel(task: PlanTask): string {
  if (task.task_type === 'reading') return '去阅读'
  if (task.task_type === 'essay') return '去写作'
  return '去练习'
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
    await Promise.all([loadCalendar(), plan.loadSessions(), loadDocuments(), plan.loadAllTasks()])
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
          :disabled="!examDate || creating || aiGenerating"
          @click="handleCreate"
        >
          {{ creating ? '生成中…' : '生成学习计划' }}
        </button>

        <!-- Divider -->
        <div class="ai-divider">
          <span class="ai-divider-text">或使用 AI 智能生成</span>
        </div>

        <div class="form-row">
          <label>每日可用学习时长</label>
          <div class="hours-row">
            <input v-model.number="dailyHours" type="number" class="hours-input" min="0.5" max="8" step="0.5" />
            <span class="hours-unit">小时/天</span>
          </div>
        </div>

        <p v-if="aiError" class="error-text">{{ aiError }}</p>
        <button
          class="btn-primary ai-create-btn"
          :disabled="!examDate || aiGenerating || creating"
          @click="handleAiCreate"
        >
          {{ aiGenerating ? 'AI 思考中…（可能需要 30 秒）' : '🤖 AI 智能生成计划' }}
        </button>
        <p class="ai-hint">AI 将根据考试日期、知识点大纲和你的学习时间，生成一份分阶段递进、无重复内容的学习计划</p>
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
          <button class="btn-ghost btn-sm" @click="handleRelinkDocs" :disabled="relinking">
            {{ relinking ? '关联中…' : '🔗 关联文档库' }}
          </button>
          <button class="btn-ghost btn-sm" @click="handleAdapt" :disabled="adapting">
            {{ adapting ? '分析中…' : '⚡ 自适应调整' }}
          </button>
          <button
            class="btn-ghost btn-sm ai-optimize-btn"
            @click="handleAiOptimize"
            :disabled="aiOptimizing"
          >
            {{ aiOptimizing ? 'AI 分析中…' : '🤖 AI 优化计划' }}
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

      <!-- View toggle tabs -->
      <div class="view-tabs">
        <button
          :class="['view-tab', viewMode === 'today' ? 'active' : '']"
          @click="viewMode = 'today'"
        >📋 今日任务</button>
        <button
          :class="['view-tab', viewMode === 'list' ? 'active' : '']"
          @click="viewMode = 'list'"
        >📊 全部任务（{{ plan.allTasks.length }}）</button>
      </div>

      <!-- ── Today/single-date view ────────────────────── -->
      <section v-if="viewMode === 'today'" class="section">
        <h2 class="section-title">
          <template v-if="isViewingOtherDate">
            {{ selectedDate }} 任务
            <button class="btn-ghost btn-xs back-today-btn" @click="backToToday">← 回到今天</button>
          </template>
          <template v-else>
            今日任务 <span class="date-badge">{{ todayStr }}</span>
          </template>
        </h2>

        <div v-if="displayedTasks.length === 0" class="empty-hint">
          {{ isViewingOtherDate ? '该日没有安排任务' : '今日没有安排任务，好好休息！' }}
        </div>

        <div v-else class="task-list">
          <div
            v-for="task in displayedTasks"
            :key="task.id"
            class="task-item"
            :class="[statusClass(task), task.locked ? 'task-locked' : '']"
          >
            <!-- 状态图标 -->
            <span class="task-status-icon" :class="statusClass(task)">{{ statusIcon(task) }}</span>

            <!-- 任务主体 -->
            <div class="task-body">
              <div class="task-header">
                <!-- 任务类型徽章 -->
                <span class="task-type-badge" :class="task.task_type || 'practice'">
                  {{ taskTypeShort(task.task_type) }}
                </span>
                <!-- 知识标签 -->
                <span class="task-tag">{{ task.knowledge_tag }}</span>
                <!-- 锁定标记 -->
                <span v-if="task.locked" class="locked-badge" title="已锁定，系统不会自动调整">🔒</span>
                <!-- 优先级标记 -->
                <span v-if="task.priority && task.priority >= 2" class="priority-badge" title="高优先级">⭐</span>
              </div>

              <!-- 任务元信息行 -->
              <div class="task-meta">
                <!-- 预计耗时 -->
                <span v-if="task.estimated_min" class="meta-item" title="预计耗时">
                  ⏱ {{ task.estimated_min }} 分钟
                </span>
                <!-- 练习题数量 -->
                <span v-if="task.task_type === 'practice' || task.task_type === 'review'" class="meta-item">
                  📝 {{ task.suggested_count }} 题
                </span>
                <!-- 关联题目数 -->
                <span v-if="getQuestionCount(task) > 0" class="meta-item" title="已关联具体题目">
                  🔗 {{ getQuestionCount(task) }} 道指定题目
                </span>
                <!-- 关联文档（多文档列表） -->
                <template v-if="getLinkedDocs(task).length > 0">
                  <span
                    v-for="doc in getLinkedDocs(task)"
                    :key="doc.doc_id"
                    class="meta-item doc-link"
                    :class="{ 'doc-official-link': doc.is_official }"
                    :title="'点击查看：' + (getDocTitle(doc.doc_id, doc.title) || '已关联教材')"
                    @click.stop="openDocInLibrary(doc.doc_id, doc.page_range)"
                  >
                    <template v-if="doc.is_official">⭐</template>
                    <template v-else>📄</template>
                    {{ getDocTitle(doc.doc_id, doc.title) || '已关联教材' }}
                    <template v-if="doc.page_range">（第 {{ doc.page_range }} 页）</template>
                    <template v-if="doc.chunk_count"> · {{ doc.chunk_count }} 段匹配</template>
                  </span>
                </template>
                <!-- 实际耗时（已完成时显示） -->
                <span v-if="task.status === 'completed' && task.actual_min" class="meta-item actual-time">
                  ✅ 实际 {{ task.actual_min }} 分钟
                </span>
              </div>
            </div>

            <!-- 操作按钮 -->
            <div class="task-actions">
              <button
                v-if="task.status === 'pending'"
                class="btn-ghost btn-xs"
                @click="handleStartTask(task.id)"
              >开始</button>
              <button
                v-if="task.status !== 'completed'"
                class="btn-primary btn-xs"
                @click="handleCompleteTask(task.id)"
              >完成</button>
              <span v-else class="done-label">已完成</span>
              <button
                class="btn-primary btn-xs practice-go-btn"
                @click="goPractice(task)"
              >{{ practiceBtnLabel(task) }}</button>
            </div>
          </div>
        </div>
      </section>

      <!-- ── All tasks list view ───────────────────────── -->
      <section v-if="viewMode === 'list'" class="section">
        <div v-if="condensedGroups.length === 0" class="empty-hint">
          暂无任务安排
        </div>

        <div v-else class="group-list">
          <div
            v-for="cg in condensedGroups"
            :key="cg.dateFrom"
            class="condensed-group"
            :class="{ 'cg-all-done': cg.completed === cg.total }"
          >
            <!-- Condensed header -->
            <div
              class="cg-header"
              :class="{ 'cg-today': cg.dateFrom <= todayStr && cg.dateTo >= todayStr }"
              @click="toggleGroup(cg.dateFrom)"
            >
              <span class="cg-expand-icon">{{ isGroupExpanded(cg.dateFrom) ? '▼' : '▶' }}</span>
              <span class="cg-date-range">
                <span v-if="cg.dateFrom <= todayStr && cg.dateTo >= todayStr" class="today-marker">● </span>
                <template v-if="cg.dateFrom === cg.dateTo">
                  {{ formatDateLabel(cg.dateFrom) }}
                </template>
                <template v-else>
                  {{ formatDateShort(cg.dateFrom) }} ~ {{ formatDateShort(cg.dateTo) }}
                  <span class="cg-day-count">（{{ dayCount(cg) }} 天）</span>
                </template>
              </span>
              <!-- Tag chips -->
              <span class="cg-tags">
                <span v-for="tag in cg.tags" :key="tag" class="cg-tag-chip">{{ tag }}</span>
              </span>
              <!-- Progress -->
              <span class="cg-progress-text">{{ cg.completed }}/{{ cg.total }}</span>
              <div class="date-mini-bar cg-mini-bar">
                <div
                  class="date-mini-fill"
                  :class="cg.completed === cg.total ? 'full' : cg.completed > 0 ? 'partial' : ''"
                  :style="{ width: cg.total ? Math.round(cg.completed / cg.total * 100) + '%' : '0%' }"
                />
              </div>
            </div>

            <!-- Expanded task rows -->
            <div v-if="isGroupExpanded(cg.dateFrom)" class="date-task-list">
              <div
                v-for="task in cg.tasks"
                :key="task.id"
                class="task-row"
                :class="[statusClass(task), task.locked ? 'task-locked' : '']"
              >
                <span class="task-row-date">{{ formatDateShort(task.date) }}</span>
                <span class="task-row-status" :class="statusClass(task)">{{ statusIcon(task) }}</span>
                <span class="task-type-badge task-type-mini" :class="task.task_type || 'practice'">
                  {{ taskTypeShort(task.task_type) }}
                </span>
                <span class="task-row-tag">{{ task.knowledge_tag }}</span>
                <span v-if="task.estimated_min" class="task-row-time">⏱{{ task.estimated_min }}m</span>
                <span v-if="task.task_type === 'practice' || task.task_type === 'review'" class="task-row-count">📝{{ task.suggested_count }}</span>
                <span v-if="task.priority && task.priority >= 2" class="priority-badge" title="高优先级">⭐</span>

                <div class="task-row-actions">
                  <button
                    v-if="task.status === 'pending'"
                    class="btn-ghost btn-xxs"
                    @click="handleStartTask(task.id)"
                  >开始</button>
                  <button
                    v-if="task.status !== 'completed'"
                    class="btn-primary btn-xxs"
                    @click="handleCompleteTask(task.id)"
                  >完成</button>
                  <span v-else class="row-done">✓</span>
                  <button
                    class="btn-primary btn-xxs row-go-btn"
                    @click="goPractice(task)"
                  >{{ practiceBtnLabel(task) }}</button>
                </div>
              </div>
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
              :class="[
                cell ? `cal-${cell.status}` : 'cal-empty',
                cell?.date === todayStr ? 'cal-today' : '',
                cell?.date === selectedDate ? 'cal-selected' : '',
                cell ? 'cal-clickable' : '',
              ]"
              @click="cell?.date && selectDate(cell.date)"
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
  background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 16px;
  padding: 40px 48px; max-width: 520px; width: 100%; text-align: center;
}
.setup-icon { font-size: 48px; margin-bottom: 16px; }
.setup-card h1 { font-size: 22px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px; }
.setup-desc { font-size: 13px; color: var(--c-text-3); margin-bottom: 28px; }
.form-row { text-align: left; margin-bottom: 20px; }
.form-row label { display: block; font-size: 12px; color: var(--c-text-2); margin-bottom: 6px; }
.date-input {
  width: 100%; padding: 9px 12px; background: var(--c-bg); border: 1px solid var(--c-border);
  border-radius: 8px; color: var(--c-text); font-size: 14px; box-sizing: border-box;
  color-scheme: dark;
}
.mode-select { display: flex; gap: 10px; }
.mode-btn {
  flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 12px 14px; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 8px;
  cursor: pointer; text-align: left; transition: border-color 0.15s;
}
.mode-btn.active { border-color: #3b82f6; background: #1e3a5f; }
.mode-btn:hover:not(.active) { border-color: var(--c-border-2); }
.mode-icon { font-size: 20px; }
.mode-name { font-size: 13px; font-weight: 600; color: var(--c-text); }
.mode-desc { font-size: 11px; color: var(--c-text-3); line-height: 1.3; }
.create-btn { width: 100%; margin-top: 8px; }

/* ── AI section ── */
.ai-divider {
  display: flex; align-items: center; margin: 24px 0 16px;
}
.ai-divider::before, .ai-divider::after {
  content: ''; flex: 1; height: 1px; background: var(--c-border);
}
.ai-divider-text {
  font-size: 11px; color: var(--c-text-3); padding: 0 12px; white-space: nowrap;
}
.hours-row { display: flex; align-items: center; gap: 8px; }
.hours-input {
  width: 70px; padding: 8px 10px; background: var(--c-bg); border: 1px solid var(--c-border);
  border-radius: 8px; color: var(--c-text); font-size: 14px; text-align: center;
}
.hours-unit { font-size: 13px; color: var(--c-text-3); }
.ai-create-btn {
  width: 100%; margin-top: 8px;
  background: linear-gradient(135deg, #7c3aed, #3b82f6);
}
.ai-create-btn:hover { background: linear-gradient(135deg, #6d28d9, #2563eb); }
.ai-hint {
  font-size: 11px; color: var(--c-text-3); text-align: center; margin-top: 8px; line-height: 1.4;
}
.error-text { color: #f87171; font-size: 13px; margin: 8px 0 0; }

/* ── Plan header ── */
.plan-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--c-panel);
}
.plan-meta { display: flex; align-items: center; gap: 12px; }
.badge {
  font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 99px;
  background: #1e3a5f; color: var(--c-brand);
}
.badge.sprint { background: #3b1e1e; color: #f87171; }
.exam-date-label { font-size: 13px; color: var(--c-text-3); }
.header-actions { display: flex; gap: 8px; }

/* ── Top row ── */
.top-row { display: flex; gap: 16px; margin-bottom: 24px; }
.countdown-card {
  background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 12px;
  padding: 24px 28px; min-width: 180px; text-align: center;
}
.countdown-num { font-size: 64px; font-weight: 800; color: #3b82f6; line-height: 1; }
.countdown-label { font-size: 13px; color: var(--c-text-3); margin-top: 4px; margin-bottom: 16px; }
.today-progress-bar {
  height: 6px; background: var(--c-bg); border-radius: 3px; overflow: hidden; margin-bottom: 6px;
}
.progress-fill { height: 100%; background: #22c55e; border-radius: 3px; transition: width 0.4s; }
.today-progress-text { font-size: 11px; color: var(--c-text-2); }

.stats-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.stat-card {
  background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px;
  padding: 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
}
.stat-val { font-size: 22px; font-weight: 700; color: var(--c-text); }
.timer-val { font-size: 20px; font-family: monospace; color: #22c55e; }
.stat-lbl { font-size: 11px; color: var(--c-text-3); }
.session-card { gap: 8px; }

/* ── Section ── */
.section { margin-bottom: 28px; }
.section-header { display: flex; justify-content: space-between; align-items: center; }
.section-title {
  font-size: 15px; font-weight: 600; color: #cbd5e1; margin-bottom: 14px;
  display: flex; align-items: center; gap: 8px;
}
.date-badge {
  font-size: 11px; font-weight: 400; color: var(--c-border-2); background: var(--c-panel);
  padding: 2px 8px; border-radius: 4px;
}
.back-today-btn {
  font-weight: 400; color: #f59e0b; border-color: #78350f; margin-left: 8px;
}
.back-today-btn:hover { color: #fbbf24; border-color: #f59e0b; }
.toggle-arrow { font-size: 12px; color: var(--c-border-2); }

/* ── Task list ── */
.task-list { display: flex; flex-direction: column; gap: 8px; }
.task-item {
  display: flex; align-items: center; gap: 12px;
  background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 8px; padding: 12px 16px;
}
.task-item.status-completed { opacity: 0.6; }
.task-status-icon { font-size: 16px; width: 20px; text-align: center; }
.task-status-icon.status-completed { color: #22c55e; }
.task-status-icon.status-in_progress { color: #f59e0b; }
.task-status-icon.status-pending { color: var(--c-border-2); }
.task-body { flex: 1; }
.task-tag { font-size: 14px; color: var(--c-text); font-weight: 500; }
.task-count { font-size: 12px; color: var(--c-text-3); margin-left: 8px; }
.task-actions { display: flex; gap: 6px; align-items: center; }
.done-label { font-size: 12px; color: #22c55e; }
.empty-hint { font-size: 13px; color: var(--c-border-2); padding: 20px 0; }

/* ── Task enhanced: header & meta ── */
.task-locked { border-left: 3px solid #f59e0b; }
.task-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.task-type-badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px;
  white-space: nowrap; flex-shrink: 0;
  color: #fff; background: #3b82f6;
}
.task-type-badge.reading  { background: #7c3aed; }
.task-type-badge.video    { background: #0891b2; }
.task-type-badge.practice { background: #2563eb; }
.task-type-badge.review   { background: #d97706; }
.task-type-badge.essay    { background: #dc2626; }
.task-type-badge.mock_exam{ background: #e11d48; }
.task-type-badge.custom   { background: #6b7280; }
.locked-badge, .priority-badge { font-size: 12px; flex-shrink: 0; cursor: help; }
.task-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  margin-top: 2px;
}
.meta-item {
  font-size: 11px; color: var(--c-text-3);
  background: var(--c-bg);
  padding: 1px 8px; border-radius: 4px;
  white-space: nowrap;
}
.meta-item.doc-link {
  color: #93c5fd; cursor: pointer;
}
.meta-item.doc-link:hover { color: #60a5fa; text-decoration: underline; }
.meta-item.doc-link.doc-official-link {
  background: #3b2e10;
  color: #fbbf24;
  border: 1px solid #78350f;
}
.meta-item.doc-link.doc-official-link:hover { color: #f59e0b; }
.meta-item.actual-time { color: #22c55e; }

/* ── Calendar ── */
.calendar-wrap { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; padding: 20px; }
.cal-nav { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 16px; }
.cal-title { font-size: 14px; font-weight: 600; color: var(--c-text); }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.cal-head { text-align: center; font-size: 11px; color: var(--c-border-2); padding: 4px 0; }
.cal-cell {
  aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
  border-radius: 6px; font-size: 12px; color: var(--c-border-2); cursor: default;
}
.cal-empty { background: transparent; }
.cal-done { background: #166534; color: #4ade80; }
.cal-partial { background: #78350f; color: #fbbf24; }
.cal-pending { background: var(--c-panel); color: var(--c-text-3); }
.cal-today { outline: 2px solid #3b82f6; }
.cal-selected { outline: 2px solid #f59e0b; box-shadow: 0 0 6px rgba(245, 158, 11, 0.5); }
.cal-clickable { cursor: pointer; }
.cal-clickable:hover { filter: brightness(1.3); }
.cal-legend { display: flex; gap: 16px; margin-top: 12px; justify-content: center; }
.leg-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--c-text-3); }
.leg-dot {
  width: 12px; height: 12px; border-radius: 3px; display: inline-block;
}

/* ── Accuracy ── */
.accuracy-list { display: flex; flex-direction: column; gap: 8px; }
.accuracy-row { display: flex; align-items: center; gap: 12px; }
.acc-tag { width: 160px; font-size: 13px; color: var(--c-text-2); flex-shrink: 0; }
.acc-bar-wrap { flex: 1; height: 6px; background: var(--c-bg); border-radius: 3px; overflow: hidden; }
.acc-bar { height: 100%; border-radius: 3px; transition: width 0.4s; }
.acc-bar.low  { background: #ef4444; }
.acc-bar.mid  { background: #3b82f6; }
.acc-bar.high { background: #22c55e; }
.acc-pct { width: 40px; text-align: right; font-size: 12px; font-weight: 600; }
.acc-pct.low  { color: #ef4444; }
.acc-pct.mid  { color: #3b82f6; }
.acc-pct.high { color: #22c55e; }
.acc-count { font-size: 11px; color: var(--c-border-2); width: 46px; text-align: right; }

/* ── Adapt section ── */
.adapt-section { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; padding: 16px 20px; }
.adjust-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.adjust-item {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px; border-radius: 6px; font-size: 13px;
}
.adjust-item.increase { background: #172d20; border-left: 3px solid #22c55e; }
.adjust-item.decrease { background: #2d1a17; border-left: 3px solid #f59e0b; }
.adj-tag { flex: 0 0 160px; color: var(--c-text); }
.adj-change { flex: 0 0 70px; font-weight: 600; }
.adjust-item.increase .adj-change { color: #22c55e; }
.adjust-item.decrease .adj-change { color: #f59e0b; }
.adj-reason { color: var(--c-text-3); font-size: 12px; }

/* ── Buttons ── */
.btn-primary {
  background: #3b82f6; color: #fff; border: none; border-radius: 6px;
  padding: 8px 18px; font-size: 13px; cursor: pointer; font-weight: 600; transition: background 0.15s;
}
.btn-primary:hover { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost {
  background: transparent; color: var(--c-text-2); border: 1px solid var(--c-border); border-radius: 6px;
  padding: 6px 14px; font-size: 13px; cursor: pointer; transition: border-color 0.15s;
}
.btn-ghost:hover { border-color: var(--c-text-3); color: var(--c-text); }
.btn-ghost.danger:hover { border-color: #ef4444; color: #ef4444; }
.btn-ghost.ai-optimize-btn { color: #a78bfa; border-color: #4c1d95; }
.btn-ghost.ai-optimize-btn:hover { border-color: #7c3aed; color: #c4b5fd; }
.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 5px 12px; font-size: 12px; }
.btn-xs { padding: 3px 10px; font-size: 11px; }
.practice-go-btn { background: #22c55e; }
.practice-go-btn:hover { background: #16a34a; }

/* ── View tabs ── */
.view-tabs {
  display: flex; gap: 0; margin-bottom: 20px;
  background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 8px;
  overflow: hidden;
}
.view-tab {
  flex: 1; padding: 10px 0; font-size: 13px; font-weight: 600;
  background: transparent; border: none; color: var(--c-text-3); cursor: pointer;
  transition: all 0.15s;
}
.view-tab:first-child { border-right: 1px solid var(--c-border); }
.view-tab.active { background: #1e3a5f; color: #60a5fa; }
.view-tab:hover:not(.active) { color: var(--c-text); }

/* ── Condensed group list ── */
.group-list { display: flex; flex-direction: column; gap: 10px; }
.condensed-group {
  background: var(--c-panel); border: 1px solid var(--c-border);
  border-radius: 10px; overflow: hidden;
}
.condensed-group.cg-all-done { opacity: 0.7; }
.cg-header {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
  transition: background 0.1s;
}
.cg-header:hover { background: var(--c-bg); }
.cg-header.cg-today { border-left: 3px solid #3b82f6; }
.cg-expand-icon { font-size: 10px; color: var(--c-text-3); width: 14px; flex-shrink: 0; }
.cg-date-range {
  font-size: 13px; font-weight: 600; color: var(--c-text);
  white-space: nowrap; min-width: 140px; flex-shrink: 0;
}
.cg-day-count { font-size: 11px; color: var(--c-text-3); font-weight: 400; margin-left: 4px; }
.today-marker { color: #3b82f6; }
.cg-tags { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; min-width: 0; }
.cg-tag-chip {
  font-size: 11px; background: var(--c-bg); color: var(--c-text-2);
  border: 1px solid var(--c-border); border-radius: 4px;
  padding: 1px 7px; white-space: nowrap;
}
.cg-progress-text {
  font-size: 11px; color: var(--c-text-3); min-width: 36px; text-align: center; flex-shrink: 0;
}
.cg-mini-bar { width: 80px; flex-shrink: 0; }
.date-mini-bar {
  height: 5px; background: var(--c-border); border-radius: 3px; overflow: hidden;
}
.date-mini-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.date-mini-fill.partial { background: #f59e0b; }
.date-mini-fill.full { background: #22c55e; }
.date-task-list { display: flex; flex-direction: column; border-top: 1px solid var(--c-border); }
.task-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 14px 7px 30px;
  border-bottom: 1px solid var(--c-border);
  font-size: 12px;
  transition: background 0.1s;
}
.task-row:last-child { border-bottom: none; }
.task-row:hover { background: rgba(59, 130, 246, 0.06); }
.task-row.status-completed { opacity: 0.55; }
.task-row-date { font-size: 10px; color: var(--c-text-3); width: 40px; flex-shrink: 0; }
.task-row-status { font-size: 13px; width: 16px; text-align: center; flex-shrink: 0; }
.task-row-status.status-completed { color: #22c55e; }
.task-row-status.status-in_progress { color: #f59e0b; }
.task-row-status.status-pending { color: var(--c-border-2); }
.task-type-mini {
  font-size: 10px; padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
}
.task-row-tag {
  flex: 1; color: var(--c-text); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.task-row-time, .task-row-count {
  font-size: 10px; color: var(--c-text-3); flex-shrink: 0;
}
.task-row-actions {
  display: flex; gap: 4px; align-items: center; flex-shrink: 0;
}
.btn-xxs { padding: 2px 7px; font-size: 10px; border-radius: 3px; }
.row-go-btn { background: #22c55e; }
.row-go-btn:hover { background: #16a34a; }
.row-done { font-size: 14px; color: #22c55e; }
.task-row .priority-badge { font-size: 10px; }
.task-row.task-locked { border-left: 3px solid #f59e0b; }
</style>
