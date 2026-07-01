import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { toIpcPayload } from '../utils/ipc'

export interface StudyPlan {
  id: string
  mode: 'normal' | 'sprint'
  exam_date: string
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface PlanTask {
  id: string
  plan_id: string
  date: string
  knowledge_tag: string
  suggested_count: number
  actual_count: number
  status: 'pending' | 'in_progress' | 'completed'
  completed_at: string | null
}

export interface CalendarDay {
  date: string
  total: number
  completed: number
}

export interface TagAccuracy {
  tag: string
  total: number
  correct: number
  rate: number
}

export interface PlanStats {
  today: { total: number; completed: number }
  streak: number
  totalStudyMs: number
  todayStudyMs: number
  tagAccuracy: TagAccuracy[]
}

export interface AdaptAdjustment {
  tag: string
  change: number
  reason: string
}

export interface StudySession {
  id: string
  plan_task_id: string | null
  type: 'manual' | 'pomodoro'
  started_at: string
  ended_at: string | null
  duration_ms: number | null
}

export const usePlanStore = defineStore('plan', () => {
  const activePlan = ref<StudyPlan | null>(null)
  const todayTasks = ref<PlanTask[]>([])
  const stats = ref<PlanStats | null>(null)
  const calendarData = ref<CalendarDay[]>([])
  const adaptAdjustments = ref<AdaptAdjustment[]>([])
  const activeSessions = ref<StudySession[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Derived
  const examDaysLeft = computed(() => {
    if (!activePlan.value?.exam_date) return null
    const exam = new Date(activePlan.value.exam_date)
    const now = new Date()
    return Math.max(0, Math.ceil((exam.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
  })

  const todayProgress = computed(() => {
    if (!stats.value) return { total: 0, completed: 0, pct: 0 }
    const { total, completed } = stats.value.today
    return { total, completed, pct: total > 0 ? Math.round((completed / total) * 100) : 0 }
  })

  const runningSession = computed(() =>
    activeSessions.value.find((s) => s.ended_at === null) ?? null
  )

  async function loadPlan(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await window.electronAPI.getPlanActive()
      if (res.success) {
        activePlan.value = res.data
        if (res.data) {
          await Promise.all([loadTodayTasks(), loadStats()])
        }
      }
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function loadTodayTasks(): Promise<void> {
    if (!activePlan.value) return
    const today = new Date().toISOString().slice(0, 10)
    const res = await window.electronAPI.getPlanTasks(toIpcPayload({
      planId: activePlan.value.id,
      dateFrom: today,
      dateTo: today,
    }))
    if (res.success) todayTasks.value = res.data
  }

  async function loadStats(): Promise<void> {
    if (!activePlan.value) return
    const res = await window.electronAPI.getPlanStats(activePlan.value.id)
    if (res.success) stats.value = res.data
  }

  async function loadCalendar(year: number, month: number): Promise<void> {
    if (!activePlan.value) return
    const res = await window.electronAPI.getPlanCalendar(toIpcPayload({ planId: activePlan.value.id, year, month }))
    if (res.success) calendarData.value = res.data
  }

  async function createPlan(examDate: string, mode: 'normal' | 'sprint'): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await window.electronAPI.createPlan(toIpcPayload({ examDate, mode }))
      if (res.success) {
        activePlan.value = res.data
        await Promise.all([loadTodayTasks(), loadStats()])
      }
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function deletePlan(): Promise<void> {
    if (!activePlan.value) return
    await window.electronAPI.deletePlan(activePlan.value.id)
    activePlan.value = null
    todayTasks.value = []
    stats.value = null
    calendarData.value = []
  }

  async function completeTask(taskId: string): Promise<void> {
    await window.electronAPI.updatePlanTask(toIpcPayload({
      taskId,
      changes: { status: 'completed' },
    }))
    // Refresh
    await Promise.all([loadTodayTasks(), loadStats()])
  }

  async function startTaskProgress(taskId: string): Promise<void> {
    await window.electronAPI.updatePlanTask(toIpcPayload({
      taskId,
      changes: { status: 'in_progress' },
    }))
    await loadTodayTasks()
  }

  async function runAdapt(): Promise<void> {
    if (!activePlan.value) return
    const res = await window.electronAPI.adaptPlan(activePlan.value.id)
    if (res.success) {
      adaptAdjustments.value = res.data.adjustments
      await loadTodayTasks()
    }
  }

  async function loadSessions(): Promise<void> {
    const res = await window.electronAPI.getTodaySessions()
    if (res.success) activeSessions.value = res.data
  }

  async function beginSession(planTaskId?: string): Promise<void> {
    const res = await window.electronAPI.startSession(toIpcPayload({ type: 'manual', planTaskId }))
    if (res.success) await loadSessions()
  }

  async function finishSession(id: string, durationMs: number): Promise<void> {
    await window.electronAPI.endSession(toIpcPayload({ id, durationMs }))
    await Promise.all([loadSessions(), loadStats()])
  }

  return {
    activePlan,
    todayTasks,
    stats,
    calendarData,
    adaptAdjustments,
    activeSessions,
    loading,
    error,
    examDaysLeft,
    todayProgress,
    runningSession,
    loadPlan,
    loadTodayTasks,
    loadStats,
    loadCalendar,
    createPlan,
    deletePlan,
    completeTask,
    startTaskProgress,
    runAdapt,
    loadSessions,
    beginSession,
    finishSession,
  }
})
