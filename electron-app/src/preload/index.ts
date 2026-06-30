import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

function invokeWithTimeout<T>(channel: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`IPC timeout: ${channel} (${timeoutMs}ms)`)),
      timeoutMs
    )
    ipcRenderer
      .invoke(channel, args)
      .then((result) => { clearTimeout(timer); resolve(result) })
      .catch((err) => { clearTimeout(timer); reject(err) })
  })
}

const customAPI = {
  // Phase 0
  ping: () => invokeWithTimeout<{ success: boolean; data?: string; error?: string }>('ping'),
  onPythonStatus: (cb: (status: { ready: boolean }) => void) => {
    const handler = (_: unknown, status: { ready: boolean }) => cb(status)
    ipcRenderer.on('python:status', handler)
    return () => ipcRenderer.removeListener('python:status', handler)
  },

  // Phase 1 — DB
  getDbStatus: () => invokeWithTimeout<{ ready: boolean; version: number }>('db:status'),

  // Phase 1 — Tasks
  createTask: (args: { type: string; payload: unknown }) =>
    invokeWithTimeout<{ id: string }>('task:create', args),
  getTask: (id: string) =>
    invokeWithTimeout<{ id: string; type: string; status: string; result: unknown } | null>('task:get', id),
  cancelTask: (id: string) => invokeWithTimeout<void>('task:cancel', id),
  onTaskProgress: (cb: (msg: { taskId: string; progress: number; message: string }) => void) => {
    const handler = (_: unknown, msg: { taskId: string; progress: number; message: string }) => cb(msg)
    ipcRenderer.on('task:progress', handler)
    return () => ipcRenderer.removeListener('task:progress', handler)
  },

  // Phase 1 — App settings
  getSettings: () => invokeWithTimeout<Record<string, unknown>>('app:getSettings'),
  setSetting: (args: { key: string; value: unknown }) =>
    invokeWithTimeout<void>('app:setSetting', args),

  // Phase 2 — Questions
  queryQuestions: (filter?: Record<string, unknown>) =>
    invokeWithTimeout<{ items: unknown[]; total: number }>('question:query', filter),
  searchQuestions: (args: { q: string; limit?: number }) =>
    invokeWithTimeout<unknown[]>('question:search', args),
  insertQuestion: (q: unknown) =>
    invokeWithTimeout<unknown>('question:insert', q),
  batchInsertQuestions: (args: { questions: unknown[] }) =>
    invokeWithTimeout<{ count: number }>('question:batchInsert', args),
  updateQuestion: (args: { id: string; changes: unknown }) =>
    invokeWithTimeout<void>('question:update', args),
  deleteQuestion: (id: string) =>
    invokeWithTimeout<void>('question:delete', id),
  toggleFavorite: (id: string) =>
    invokeWithTimeout<{ is_favorite: number }>('question:toggleFavorite', id),
  getQuestionStats: () =>
    invokeWithTimeout<Record<string, unknown>>('question:getStats'),

  // Phase 2 — Practice
  startPractice: (config: unknown) =>
    invokeWithTimeout<{ sessionId: string; questions: unknown[] }>('practice:start', config),
  submitAnswer: (args: { sessionId: string; questionId: string; chosen: string; timeMs: number }) =>
    invokeWithTimeout<{ isCorrect: boolean; answer: string | null; explanation: string | null; nextIndex: number }>(
      'practice:submitAnswer', args
    ),
  endPractice: (sessionId: string) =>
    invokeWithTimeout<{ totalCount: number; correctCount: number; durationMs: number }>('practice:end', sessionId),
  getWrongQuestions: (args?: { limit?: number }) =>
    invokeWithTimeout<unknown[]>('practice:getWrong', args),

  // Phase 3 — Documents
  listDocuments: () => invokeWithTimeout<unknown[]>('doc:list'),
  importDocument: () =>
    invokeWithTimeout<{ document: unknown; taskId?: string; duplicate?: boolean } | null>('doc:import', undefined, 60_000),
  deleteDocument: (id: string) => invokeWithTimeout<void>('doc:delete', id),
  getDocChunks: (docId: string) => invokeWithTimeout<unknown[]>('doc:getChunks', docId),

  // Phase 3 — AI
  getAiConfig: () => invokeWithTimeout<Record<string, unknown>>('ai:getConfig'),
  setAiConfig: (args: unknown) => invokeWithTimeout<void>('ai:setConfig', args),
  testAiConnection: () => invokeWithTimeout<{ ok: boolean; reply: string }>('ai:testConnection', undefined, 30_000),
  generateQuestions: (args: unknown) =>
    invokeWithTimeout<{ questions: unknown[] }>('ai:generateQuestions', args, 120_000),
  gradeEssay: (args: unknown) =>
    invokeWithTimeout<unknown>('ai:gradeEssay', args, 120_000),
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('electronAPI', customAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.electronAPI = customAPI
}
