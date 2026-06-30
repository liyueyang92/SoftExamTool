import { ElectronAPI } from '@electron-toolkit/preload'

export type IpcResponse<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } }

export interface Task {
  id: string
  type: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  payload: unknown
  result: unknown
  created_at: string
  updated_at: string
}

export interface ProgressMessage {
  taskId: string
  progress: number
  message: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    electronAPI: {
      // Phase 0
      ping: () => Promise<IpcResponse<string>>
      onPythonStatus: (cb: (status: { ready: boolean }) => void) => () => void

      // Phase 1 — DB
      getDbStatus: () => Promise<IpcResponse<{ ready: boolean; version: number }>>

      // Phase 1 — Tasks
      createTask: (args: { type: string; payload: unknown }) => Promise<IpcResponse<{ id: string }>>
      getTask: (id: string) => Promise<IpcResponse<Task | null>>
      cancelTask: (id: string) => Promise<IpcResponse<void>>
      onTaskProgress: (cb: (msg: ProgressMessage) => void) => () => void

      // Phase 1 — App settings
      getSettings: () => Promise<IpcResponse<Record<string, unknown>>>
      setSetting: (args: { key: string; value: unknown }) => Promise<IpcResponse<void>>

      // Phase 2 — Questions
      queryQuestions: (filter?: Record<string, unknown>) => Promise<IpcResponse<{ items: unknown[]; total: number }>>
      searchQuestions: (args: { q: string; limit?: number }) => Promise<IpcResponse<unknown[]>>
      insertQuestion: (q: unknown) => Promise<IpcResponse<unknown>>
      batchInsertQuestions: (args: { questions: unknown[] }) => Promise<IpcResponse<{ count: number }>>
      updateQuestion: (args: { id: string; changes: unknown }) => Promise<IpcResponse<void>>
      deleteQuestion: (id: string) => Promise<IpcResponse<void>>
      toggleFavorite: (id: string) => Promise<IpcResponse<{ is_favorite: number }>>
      getQuestionStats: () => Promise<IpcResponse<Record<string, unknown>>>

      // Phase 2 — Practice
      startPractice: (config: unknown) => Promise<IpcResponse<{ sessionId: string; questions: unknown[] }>>
      submitAnswer: (args: { sessionId: string; questionId: string; chosen: string; timeMs: number }) => Promise<IpcResponse<{ isCorrect: boolean; answer: string | null; explanation: string | null; nextIndex: number }>>
      endPractice: (sessionId: string) => Promise<IpcResponse<{ totalCount: number; correctCount: number; durationMs: number }>>
      getWrongQuestions: (args?: { limit?: number }) => Promise<IpcResponse<unknown[]>>

      // Phase 3 — Documents
      listDocuments: () => Promise<IpcResponse<unknown[]>>
      importDocument: () => Promise<IpcResponse<{ document: unknown; taskId?: string; duplicate?: boolean } | null>>
      deleteDocument: (id: string) => Promise<IpcResponse<void>>
      getDocChunks: (docId: string) => Promise<IpcResponse<unknown[]>>

      // Phase 3 — AI
      getAiConfig: () => Promise<IpcResponse<Record<string, unknown>>>
      setAiConfig: (args: unknown) => Promise<IpcResponse<void>>
      testAiConnection: () => Promise<IpcResponse<{ ok: boolean; reply: string }>>
      generateQuestions: (args: unknown) => Promise<IpcResponse<{ questions: unknown[] }>>
      gradeEssay: (args: unknown) => Promise<IpcResponse<unknown>>

      // Phase 5 — Crawler
      listCrawlerRules: () => Promise<IpcResponse<unknown[]>>
      upsertCrawlerRule: (args: unknown) => Promise<IpcResponse<unknown>>
      deleteCrawlerRule: (id: string) => Promise<IpcResponse<void>>
      testCrawl: (args: unknown) => Promise<IpcResponse<{ count: number; samples: unknown[] }>>
      runCrawl: (args: { ruleId: string }) => Promise<IpcResponse<{ taskId: string; runId: string }>>
      listCrawlerRuns: (ruleId: string) => Promise<IpcResponse<unknown[]>>

      // Phase 5 — Knowledge Graph
      buildGraph: () => Promise<IpcResponse<{ nodes: unknown[]; edges: unknown[] }>>

      // Phase 5 — Essay
      listEssays: () => Promise<IpcResponse<unknown[]>>
      createEssay: (args?: { title?: string }) => Promise<IpcResponse<unknown>>
      getEssay: (id: string) => Promise<IpcResponse<{ essay: unknown; sections: unknown[] } | null>>
      updateEssaySection: (args: { essayId: string; sectionKey: string; content: string }) => Promise<IpcResponse<unknown>>
      updateEssayMeta: (args: { id: string; title?: string; question?: string }) => Promise<IpcResponse<void>>
      saveEssayVersion: (essayId: string) => Promise<IpcResponse<unknown>>
      listEssayVersions: (essayId: string) => Promise<IpcResponse<unknown[]>>
      restoreEssayVersion: (args: { essayId: string; versionId: string }) => Promise<IpcResponse<void>>
      deleteEssay: (id: string) => Promise<IpcResponse<void>>
      listEssayMaterials: () => Promise<IpcResponse<unknown[]>>
      upsertEssayMaterial: (args: unknown) => Promise<IpcResponse<unknown>>
      deleteEssayMaterial: (id: string) => Promise<IpcResponse<void>>
      essayAiSuggest: (args: unknown) => Promise<IpcResponse<{ suggestions: string }>>

      // Phase 5 — AI Chat with RAG
      aiChat: (args: { question: string; useDocContext?: boolean }) => Promise<IpcResponse<{ answer: string; sources: unknown[] }>>

      // Phase 4 — Study Plans
      getPlanActive: () => Promise<IpcResponse<StudyPlan | null>>
      createPlan: (args: { examDate: string; mode: 'normal' | 'sprint'; config?: Record<string, unknown> }) => Promise<IpcResponse<StudyPlan>>
      deletePlan: (id: string) => Promise<IpcResponse<void>>
      getPlanTasks: (args: { planId: string; dateFrom?: string; dateTo?: string }) => Promise<IpcResponse<PlanTask[]>>
      updatePlanTask: (args: { taskId: string; changes: { status?: string; actual_count?: number } }) => Promise<IpcResponse<void>>
      getPlanStats: (planId: string) => Promise<IpcResponse<PlanStats>>
      getPlanCalendar: (args: { planId: string; year: number; month: number }) => Promise<IpcResponse<CalendarDay[]>>
      adaptPlan: (planId: string) => Promise<IpcResponse<{ adjustments: AdaptAdjustment[] }>>

      // Phase 4 — Study Sessions
      startSession: (args?: { type?: 'manual' | 'pomodoro'; planTaskId?: string }) => Promise<IpcResponse<StudySession>>
      endSession: (args: { id: string; durationMs: number }) => Promise<IpcResponse<void>>
      getTodaySessions: () => Promise<IpcResponse<StudySession[]>>

      // Phase 6 — Achievements
      listAchievements: () => Promise<IpcResponse<Achievement[]>>
      checkAchievements: () => Promise<IpcResponse<Achievement[]>>
      onAchievementUnlocked: (cb: (achievements: Achievement[]) => void) => () => void

      // Phase 6 — Backup & Restore
      listBackups: () => Promise<IpcResponse<BackupRecord[]>>
      createBackup: (args?: { note?: string }) => Promise<IpcResponse<BackupRecord>>
      restoreBackup: () => Promise<IpcResponse<{ restored: boolean }>>
      deleteBackup: (id: string) => Promise<IpcResponse<void>>
    }
  }
}

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

export interface Achievement {
  id: string
  title: string
  desc: string
  icon: string
  condition: { type: string; value: number }
  unlocked_at: string | null
}

export interface BackupRecord {
  id: string
  file_path: string
  size_bytes: number
  note: string
  created_at: string
}
