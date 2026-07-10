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
  getPythonStatus: () => invokeWithTimeout<{ ready: boolean }>('python:getStatus'),

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
  getStoragePaths: () => invokeWithTimeout<unknown>('app:getStoragePaths'),
  setStoragePaths: (args: { dataRootDir?: string }) =>
    invokeWithTimeout<unknown>('app:setStoragePaths', args, 120_000),
  pickDirectory: (args?: { title?: string; defaultPath?: string }) =>
    invokeWithTimeout<string | null>('app:pickDirectory', args),
  relaunchApp: () => invokeWithTimeout<void>('app:relaunch'),

  // Phase 2 — Questions
  listQuestionGroups: () =>
    invokeWithTimeout<unknown[]>('questionGroup:list'),
  upsertQuestionGroup: (args: unknown) =>
    invokeWithTimeout<unknown>('questionGroup:upsert', args),
  deleteQuestionGroup: (id: string) =>
    invokeWithTimeout<void>('questionGroup:delete', id),
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
  pickDocumentFile: () =>
    invokeWithTimeout<{ filePath: string; fileName: string; title: string } | null>('doc:pickFile'),
  previewDocumentImport: (args: {
    filePath: string
    previewPage: number
    topMarginRatio?: number
    bottomMarginRatio?: number
  }) =>
    invokeWithTimeout<{
      page_count: number
      preview_page: number
      crop_ratios: { top_margin_ratio: number; bottom_margin_ratio: number }
      crop_bbox: { x0: number; top: number; x1: number; bottom: number }
      text: string
    }>('doc:preview', args, 60_000),
  importDocument: (args?: {
    filePath?: string
    topMarginRatio?: number
    bottomMarginRatio?: number
    startPage?: number
    endPage?: number | null
  }) =>
    invokeWithTimeout<{ document: unknown; taskId?: string; duplicate?: boolean; reparsing?: boolean } | null>('doc:import', args, 60_000),
  deleteDocument: (id: string) => invokeWithTimeout<void>('doc:delete', id),
  getDocChunks: (docId: string) => invokeWithTimeout<unknown[]>('doc:getChunks', docId),

  // Phase 3 — AI
  getAiConfig: () => invokeWithTimeout<Record<string, unknown>>('ai:getConfig'),
  setAiConfig: (args: unknown) => invokeWithTimeout<void>('ai:setConfig', args),
  testAiConnection: (args?: unknown) =>
    invokeWithTimeout<{ ok: boolean; reply: string }>('ai:testConnection', args, 30_000),
  generateQuestions: (args: unknown) =>
    invokeWithTimeout<{ questions: unknown[]; target_group_id?: string | null; new_group?: unknown | null }>('ai:generateQuestions', args, 120_000),
  gradeEssay: (args: unknown) =>
    invokeWithTimeout<unknown>('ai:gradeEssay', args, 120_000),

  // Phase 5 — Crawler
  listCrawlerRules: () => invokeWithTimeout<unknown[]>('crawler:listRules'),
  upsertCrawlerRule: (args: unknown) => invokeWithTimeout<unknown>('crawler:upsertRule', args),
  deleteCrawlerRule: (id: string) => invokeWithTimeout<void>('crawler:deleteRule', id),
  testCrawl: (args: unknown) => invokeWithTimeout<{ count: number; samples: unknown[] }>('crawler:test', args, 30_000),
  runCrawl: (args: { ruleId: string; account_alias?: string | null }) =>
    invokeWithTimeout<{ taskId: string; runId: string }>('crawler:run', args),
  listCrawlerRuns: (ruleId: string) => invokeWithTimeout<unknown[]>('crawler:listRuns', ruleId),
  deleteCrawlerRun: (id: string) => invokeWithTimeout<void>('crawler:deleteRun', id),
  startCrawlerAuth: (args: { ruleId: string; account_alias?: string }) =>
    invokeWithTimeout<unknown>('crawler:authStart', args, 300_000),
  openCrawlerVisualConfig: (args: { ruleId: string; account_alias?: string }) =>
    invokeWithTimeout<unknown>('crawler:visualConfig', args, 300_000),
  listCrawlerSessions: (args?: { ruleId?: string }) =>
    invokeWithTimeout<unknown[]>('crawler:listSessions', args),
  validateCrawlerSession: (args: { ruleId: string; account_alias: string }) =>
    invokeWithTimeout<{ valid: boolean; status?: number; message?: string; checks?: Array<{ name: string; valid: boolean; message: string }> }>('crawler:validateSession', args, 60_000),
  deleteCrawlerSession: (args: { ruleId: string; account_alias: string }) =>
    invokeWithTimeout<void>('crawler:deleteSession', args),
  listCrawlerReviewItems: (args?: { status?: string; ruleId?: string; runId?: string; limit?: number }) =>
    invokeWithTimeout<unknown[]>('crawler:listReviewItems', args),
  rejectCrawlerReviewItems: (args: { ids: string[]; notes?: string }) =>
    invokeWithTimeout<void>('crawler:rejectReviewItems', args),
  importCrawlerReviewItems: (args: { ids: string[]; target_group_id?: string | null; new_group?: unknown | null }) =>
    invokeWithTimeout<{ count: number }>('crawler:importReviewItems', args),
  inspectCrawlerLoad: (args: unknown) =>
    invokeWithTimeout<unknown>('crawler:inspectLoad', args, 60_000),
  inspectCrawlerPreview: (args: unknown) =>
    invokeWithTimeout<unknown>('crawler:inspectPreview', args, 60_000),
  suggestCrawlerSelector: (args: unknown) =>
    invokeWithTimeout<unknown>('crawler:suggestSelector', args, 30_000),
  getCrawlerRuntimeStatus: () =>
    invokeWithTimeout<unknown>('crawler:runtimeStatus', undefined, 60_000),

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
  aiChat: (args: { sessionId: string; question: string; useDocContext?: boolean }) =>
    invokeWithTimeout<{ answer: string; sources: unknown[] }>('ai:chat', args, 60_000),
  listAiChatSessions: (args?: { limit?: number }) =>
    invokeWithTimeout<unknown[]>('ai:chatSessions:list', args),
  createAiChatSession: (args?: { title?: string }) =>
    invokeWithTimeout<unknown>('ai:chatSession:create', args),
  deleteAiChatSession: (sessionId: string) =>
    invokeWithTimeout<void>('ai:chatSession:delete', sessionId),
  listAiChatMessages: (args: { sessionId: string; limit?: number }) =>
    invokeWithTimeout<unknown[]>('ai:chatMessages:list', args),

  // Phase 4 — Study Plans
  getPlanActive: () => invokeWithTimeout<unknown | null>('plan:getActive'),
  createPlan: (args: { examDate: string; mode: 'normal' | 'sprint'; config?: Record<string, unknown> }) =>
    invokeWithTimeout<unknown>('plan:create', args),
  deletePlan: (id: string) => invokeWithTimeout<void>('plan:delete', id),
  getPlanTasks: (args: { planId: string; dateFrom?: string; dateTo?: string }) =>
    invokeWithTimeout<unknown[]>('plan:getTasks', args),
  updatePlanTask: (args: { taskId: string; changes: { status?: string; actual_count?: number } }) =>
    invokeWithTimeout<void>('plan:updateTask', args),
  getPlanStats: (planId: string) => invokeWithTimeout<unknown>('plan:getStats', planId),
  getPlanCalendar: (args: { planId: string; year: number; month: number }) =>
    invokeWithTimeout<unknown[]>('plan:getCalendar', args),
  adaptPlan: (planId: string) => invokeWithTimeout<{ adjustments: unknown[] }>('plan:adapt', planId),

  // Phase 4 — Study Sessions
  startSession: (args?: { type?: 'manual' | 'pomodoro'; planTaskId?: string }) =>
    invokeWithTimeout<unknown>('session:start', args),
  endSession: (args: { id: string; durationMs: number }) =>
    invokeWithTimeout<void>('session:end', args),
  getTodaySessions: () => invokeWithTimeout<unknown[]>('session:getToday'),

  // Phase 6 — Achievements
  listAchievements: () => invokeWithTimeout<unknown[]>('achievement:list'),
  checkAchievements: () => invokeWithTimeout<unknown[]>('achievement:check'),
  onAchievementUnlocked: (cb: (achievements: unknown[]) => void) => {
    const handler = (_: unknown, data: unknown[]) => cb(data)
    ipcRenderer.on('achievement:unlocked', handler)
    return () => ipcRenderer.removeListener('achievement:unlocked', handler)
  },

  // Phase 6 — Backup & Restore
  listBackups: () => invokeWithTimeout<unknown[]>('backup:list'),
  createBackup: (args?: { note?: string }) =>
    invokeWithTimeout<unknown>('backup:create', args, 60_000),
  restoreBackup: () =>
    invokeWithTimeout<{ restored: boolean }>('backup:restore', undefined, 30_000),
  deleteBackup: (id: string) => invokeWithTimeout<void>('backup:delete', id),
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
