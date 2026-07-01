import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Question } from './question'
import { toIpcPayload } from '../utils/ipc'

export interface PracticeConfig {
  mode: 'random' | 'sequential' | 'wrong' | 'favorites'
  count: number
  filterTags?: string[]
  filterTypes?: string[]
}

export interface AnswerResult {
  isCorrect: boolean
  answer: string | null
  explanation: string | null
  nextIndex: number
}

export interface SessionResult {
  totalCount: number
  correctCount: number
  durationMs: number
}

export const usePracticeStore = defineStore('practice', () => {
  const sessionId = ref<string | null>(null)
  const questions = ref<Question[]>([])
  const currentIndex = ref(0)
  const answers = ref<Record<string, AnswerResult>>({})
  const lastAnswer = ref<AnswerResult | null>(null)
  const sessionResult = ref<SessionResult | null>(null)
  const phase = ref<'config' | 'answering' | 'reviewing' | 'done'>('config')
  const startTime = ref(0)

  const currentQuestion = computed(() => questions.value[currentIndex.value] ?? null)
  const progress = computed(() =>
    questions.value.length ? Math.round((currentIndex.value / questions.value.length) * 100) : 0
  )
  const isFinished = computed(() => currentIndex.value >= questions.value.length)

  async function start(config: PracticeConfig) {
    const payload = toIpcPayload<PracticeConfig>({
      mode: config.mode,
      count: config.count,
      filterTags: config.filterTags ? [...config.filterTags] : undefined,
      filterTypes: config.filterTypes ? [...config.filterTypes] : undefined,
    })
    const res = await window.electronAPI.startPractice(payload)
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const data = res.data as { sessionId: string; questions: Question[] }
    sessionId.value = data.sessionId
    questions.value = data.questions
    currentIndex.value = 0
    answers.value = {}
    lastAnswer.value = null
    sessionResult.value = null
    startTime.value = Date.now()
    phase.value = 'answering'
  }

  async function submitAnswer(chosen: string) {
    if (!sessionId.value || !currentQuestion.value) return
    const timeMs = Date.now() - startTime.value
    const res = await window.electronAPI.submitAnswer(toIpcPayload({
      sessionId: sessionId.value,
      questionId: currentQuestion.value.id,
      chosen,
      timeMs,
    }))
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const result = res.data as AnswerResult
    answers.value[currentQuestion.value.id] = result
    lastAnswer.value = result
    currentIndex.value = result.nextIndex
    phase.value = 'reviewing'
    startTime.value = Date.now()
  }

  function continueNext() {
    lastAnswer.value = null
    if (isFinished.value) {
      phase.value = 'done'
    } else {
      phase.value = 'answering'
    }
  }

  async function end(): Promise<SessionResult> {
    if (!sessionId.value) throw new Error('No active session')
    const res = await window.electronAPI.endPractice(sessionId.value)
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const result = res.data as SessionResult
    sessionResult.value = result
    phase.value = 'done'
    return result
  }

  function reset() {
    sessionId.value = null
    questions.value = []
    currentIndex.value = 0
    answers.value = {}
    lastAnswer.value = null
    sessionResult.value = null
    phase.value = 'config'
  }

  return {
    sessionId, questions, currentIndex, answers, lastAnswer, sessionResult, phase,
    currentQuestion, progress, isFinished,
    start, submitAnswer, continueNext, end, reset,
  }
})
