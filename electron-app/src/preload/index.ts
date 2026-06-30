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

  // Phase 5 — Crawler
  listCrawlerRules: () => invokeWithTimeout<unknown[]>('crawler:listRules'),
  upsertCrawlerRule: (args: unknown) => invokeWithTimeout<unknown>('crawler:upsertRule', args),
  deleteCrawlerRule: (id: string) => invokeWithTimeout<void>('crawler:deleteRule', id),
  testCrawl: (args: unknown) => invokeWithTimeout<{ count: number; samples: unknown[] }>('crawler:test', args, 30_000),
  runCrawl: (args: { ruleId: string }) => invokeWithTimeout<{ taskId: string; runId: string }>('crawler:run', args),
  listCrawlerRuns: (ruleId: string) => invokeWithTimeout<unknown[]>('crawler:listRuns', ruleId),

  // Phase 5 — Knowledge Graph
  buildGraph: () => invokeWithTimeout<{ nodes: unknown[]; edges: unknown[] }>('graph:build'),

  // Phase 5 — Essay
  listEssays: () => invokeWithTimeout<unknown[]>('essay:list'),
  createEssay: (args?: { title?: string }) => invokeWithTimeout<unknown>('essay:create', args),
  getEssay: (id: string) => invokeWithTimeout<{ essay: unknown; sections: unknown[] } | null>('essay:get', id),
  updateEssaySection: (args: { essayId: string; sectionKey: string; content: string }) =>
    invokeWithTimeout<unknown>('essay:updateSection', args),
  updateEssayMeta: (args: { id: string; title?: string; question?: string }) =>
    invokeWithTimeout<void>('essay:updateMeta', args),
  saveEssayVersion: (essayId: string) => invokeWithTimeout<unknown>('essay:saveVersion', essayId),
  listEssayVersions: (essayId: string) => invokeWithTimeout<unknown[]>('essay:listVersions', essayId),
  restoreEssayVersion: (args: { essayId: string; versionId: string }) =>
    invokeWithTimeout<void>('essay:restoreVersion', args),
  deleteEssay: (id: string) => invokeWithTimeout<void>('essay:delete', id),
  listEssayMaterials: () => invokeWithTimeout<unknown[]>('essay:listMaterials'),
  upsertEssayMaterial: (args: unknown) => invokeWithTimeout<unknown>('essay:upsertMaterial', args),
  deleteEssayMaterial: (id: string) => invokeWithTimeout<void>('essay:deleteMaterial', id),
  essayAiSuggest: (args: unknown) => invokeWithTimeout<{ suggestions: string }>('essay:aiSuggest', args, 60_000),

  // Phase 5 — AI Chat with RAG
  aiChat: (args: { question: string; useDocContext?: boolean }) =>
    invokeWithTimeout<{ answer: string; sources: unknown[] }>('ai:chat', args, 60_000),
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
