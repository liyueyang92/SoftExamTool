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
    }
  }
}
