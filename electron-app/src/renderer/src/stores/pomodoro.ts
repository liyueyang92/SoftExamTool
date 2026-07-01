import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { toIpcPayload } from '../utils/ipc'

type PomodoroPhase = 'work' | 'short-break' | 'long-break' | 'idle'

const WORK_MIN = 25
const SHORT_BREAK_MIN = 5
const LONG_BREAK_MIN = 15
const LONG_BREAK_AFTER = 4 // pomodoros before long break

function phaseDuration(phase: PomodoroPhase): number {
  if (phase === 'work') return WORK_MIN * 60
  if (phase === 'short-break') return SHORT_BREAK_MIN * 60
  if (phase === 'long-break') return LONG_BREAK_MIN * 60
  return 0
}

export const usePomodoroStore = defineStore('pomodoro', () => {
  const phase = ref<PomodoroPhase>('idle')
  const remainingSeconds = ref(0)
  const completedCount = ref(0) // pomodoros completed this session
  const totalCompleted = ref(0) // persisted across store lifetime
  const running = ref(false)
  const currentSessionId = ref<string | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null
  let sessionStartMs = 0

  const displayTime = computed(() => {
    const m = Math.floor(remainingSeconds.value / 60)
    const s = remainingSeconds.value % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  })

  const phaseLabel = computed(() => {
    if (phase.value === 'work') return '专注工作'
    if (phase.value === 'short-break') return '短暂休息'
    if (phase.value === 'long-break') return '长时间休息'
    return '准备开始'
  })

  function start(planTaskId?: string) {
    if (running.value) return
    if (phase.value === 'idle') {
      phase.value = 'work'
      remainingSeconds.value = phaseDuration('work')
    }
    running.value = true
    sessionStartMs = Date.now()

    if (phase.value === 'work') {
      // Start a pomodoro session in the DB
      window.electronAPI.startSession(toIpcPayload({ type: 'pomodoro', planTaskId })).then((res) => {
        if (res.success && res.data) {
          currentSessionId.value = (res.data as { id: string }).id
        }
      })
    }

    timer = setInterval(() => {
      if (remainingSeconds.value <= 0) {
        clearInterval(timer!)
        timer = null
        onPhaseComplete()
      } else {
        remainingSeconds.value--
      }
    }, 1000)
  }

  function pause() {
    if (!running.value) return
    running.value = false
    if (timer) { clearInterval(timer); timer = null }
  }

  function resume() {
    if (running.value || phase.value === 'idle') return
    start()
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
    if (currentSessionId.value && phase.value === 'work') {
      const elapsed = Date.now() - sessionStartMs
      window.electronAPI.endSession(toIpcPayload({ id: currentSessionId.value, durationMs: elapsed }))
      currentSessionId.value = null
    }
    running.value = false
    phase.value = 'idle'
    remainingSeconds.value = 0
  }

  function onPhaseComplete() {
    const elapsed = Date.now() - sessionStartMs

    if (phase.value === 'work') {
      // End the session in DB
      if (currentSessionId.value) {
        window.electronAPI.endSession(toIpcPayload({ id: currentSessionId.value, durationMs: elapsed }))
        currentSessionId.value = null
      }
      completedCount.value++
      totalCompleted.value++

      // Trigger achievement check after completing a pomodoro
      window.electronAPI.checkAchievements()

      const isLong = completedCount.value % LONG_BREAK_AFTER === 0
      phase.value = isLong ? 'long-break' : 'short-break'
      remainingSeconds.value = phaseDuration(phase.value)

      // Send desktop notification
      try {
        new window.Notification('番茄钟完成！', {
          body: isLong ? `完成 ${completedCount.value} 个番茄！享受 ${LONG_BREAK_MIN} 分钟长休息。` : `休息 ${SHORT_BREAK_MIN} 分钟，然后继续！`,
        })
      } catch { /* notification not available */ }
    } else {
      // Break done → back to work
      phase.value = 'work'
      remainingSeconds.value = phaseDuration('work')
      try {
        new window.Notification('休息结束', { body: '开始下一个番茄钟！' })
      } catch { /* */ }
    }

    running.value = false // user must manually start next phase
  }

  function skipToNext() {
    if (timer) { clearInterval(timer); timer = null }
    running.value = false
    if (phase.value === 'work' && currentSessionId.value) {
      const elapsed = Date.now() - sessionStartMs
      window.electronAPI.endSession(toIpcPayload({ id: currentSessionId.value, durationMs: elapsed }))
      currentSessionId.value = null
      completedCount.value++
      totalCompleted.value++
    }
    const isLong = completedCount.value % LONG_BREAK_AFTER === 0
    phase.value = phase.value === 'work'
      ? (isLong ? 'long-break' : 'short-break')
      : 'work'
    remainingSeconds.value = phaseDuration(phase.value)
  }

  function resetToWork() {
    stop()
    phase.value = 'idle'
    remainingSeconds.value = 0
    completedCount.value = 0
  }

  return {
    phase, remainingSeconds, completedCount, totalCompleted, running,
    displayTime, phaseLabel,
    start, pause, resume, stop, skipToNext, resetToWork,
  }
})
