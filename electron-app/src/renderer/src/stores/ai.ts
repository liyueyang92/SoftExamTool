import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Question } from './question'

export interface AiConfig {
  mode: 'openai' | 'ollama'
  openai: { baseUrl: string; apiKey: string; model: string }
  ollama: { baseUrl: string; model: string }
}

export interface GenerateParams {
  count: number
  types: string[]
  knowledge_tags: string[]
  difficulty?: number
  context?: string
}

export interface GradeResult {
  total_score: number
  dimension_scores: Array<{ name: string; score: number; max_score: number; comment: string }>
  feedback: string
  suggestions: string[]
}

export const useAiStore = defineStore('ai', () => {
  const config = ref<AiConfig>({
    mode: 'openai',
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5' },
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
      config.value = res.data as AiConfig
      configLoaded.value = true
    }
  }

  async function saveConfig(patch: Partial<AiConfig>) {
    await window.electronAPI.setAiConfig(patch)
    Object.assign(config.value, patch)
  }

  async function testConnection() {
    testingConnection.value = true
    connectionResult.value = null
    try {
      const res = await window.electronAPI.testAiConnection()
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
      const res = await window.electronAPI.generateQuestions(params)
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
      const res = await window.electronAPI.gradeEssay(args)
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
