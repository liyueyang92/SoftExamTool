import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Question } from './question'
import { toIpcPayload } from '../utils/ipc'

export type QuestionGroupType = 'custom' | 'past_exam' | 'ai_generated' | 'crawled' | 'manual_import'
export type ExamPeriod = 'H1' | 'H2'

export interface NewQuestionGroupInput {
  name: string
  group_type?: QuestionGroupType
  exam_year?: number | null
  exam_period?: ExamPeriod | null
  description?: string
}

export interface AiConfig {
  mode: 'openai' | 'ollama' | 'anthropic'
  openai: { baseUrl: string; apiKey: string; model: string }
  ollama: { baseUrl: string; model: string }
  anthropic: { apiKey: string; model: string }
}

export interface GenerateParams {
  count: number
  types: string[]
  knowledge_tags: string[]
  difficulty?: number
  context?: string
  target_group_id?: string | null
  new_group?: NewQuestionGroupInput | null
}

export interface GradeResult {
  total_score: number
  dimension_scores: Array<{ name: string; score: number; max_score: number; comment: string }>
  feedback: string
  suggestions: string[]
}

function toPlainAiConfigPatch(patch?: Partial<AiConfig>): Partial<AiConfig> | undefined {
  return patch ? toIpcPayload(patch) : undefined
}

function toPlainGenerateParams(params: GenerateParams): GenerateParams {
  return toIpcPayload(params)
}

function toPlainGradeArgs(args: {
  question: string
  reference_points?: string
  user_answer: string
}): {
  question: string
  reference_points?: string
  user_answer: string
} {
  return toIpcPayload(args)
}

export const useAiStore = defineStore('ai', () => {
  const config = ref<AiConfig>({
    mode: 'openai',
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5' },
    anthropic: { apiKey: '', model: 'claude-sonnet-4-6' },
  })
  const configLoaded = ref(false)
  const testingConnection = ref(false)
  const connectionResult = ref<{ ok: boolean; reply: string } | null>(null)
  const generating = ref(false)
  const generatedQuestions = ref<Question[]>([])
  const grading = ref(false)
  const gradeResult = ref<GradeResult | null>(null)

  async function loadConfig() {
    const res = await window.electronAPI.getAiConfig()
    if (res.success) {
      config.value = res.data as unknown as AiConfig
      configLoaded.value = true
    }
  }

  async function saveConfig(patch: Partial<AiConfig>) {
    const plainPatch = toPlainAiConfigPatch(patch) ?? {}
    await window.electronAPI.setAiConfig(plainPatch)
    Object.assign(config.value, plainPatch)
  }

  async function testConnection(configOverride?: Partial<AiConfig>) {
    testingConnection.value = true
    connectionResult.value = null
    try {
      const res = await window.electronAPI.testAiConnection(toPlainAiConfigPatch(configOverride))
      if (res.success) connectionResult.value = res.data as { ok: boolean; reply: string }
      else connectionResult.value = { ok: false, reply: (res.error as { message: string }).message }
    } catch (e) {
      connectionResult.value = { ok: false, reply: String(e) }
    } finally {
      testingConnection.value = false
    }
  }

  async function generateQuestions(params: GenerateParams): Promise<Question[]> {
    generating.value = true
    generatedQuestions.value = []
    try {
      const res = await window.electronAPI.generateQuestions(toPlainGenerateParams(params))
      if (res.success) {
        generatedQuestions.value = (res.data as { questions: Question[] }).questions
        return generatedQuestions.value
      }
      throw new Error((res.error as { message: string }).message)
    } finally {
      generating.value = false
    }
  }

  async function gradeEssay(args: { question: string; reference_points?: string; user_answer: string }): Promise<GradeResult> {
    grading.value = true
    gradeResult.value = null
    try {
      const res = await window.electronAPI.gradeEssay(toPlainGradeArgs(args))
      if (res.success) {
        gradeResult.value = res.data as GradeResult
        return gradeResult.value
      }
      throw new Error((res.error as { message: string }).message)
    } finally {
      grading.value = false
    }
  }

  return {
    config, configLoaded, testingConnection, connectionResult, generating, generatedQuestions, grading, gradeResult,
    loadConfig, saveConfig, testConnection, generateQuestions, gradeEssay,
  }
})
