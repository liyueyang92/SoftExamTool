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
  clearAllData: () => invokeWithTimeout<{ count: number }>('db:clearAll'),

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
  onTaskPartial: (cb: (data: {
    taskId: string; pageNum: number; totalPages: number
    chunks: unknown[]; assets: unknown[]; warnings: unknown[]
  }) => void) => {
    const handler = (_: unknown, data: {
      taskId: string; pageNum: number; totalPages: number
      chunks: unknown[]; assets: unknown[]; warnings: unknown[]
    }) => cb(data)
    ipcRenderer.on('task:partial', handler)
    return () => ipcRenderer.removeListener('task:partial', handler)
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
  countQuestionsInGroup: (id: string) =>
    invokeWithTimeout<number>('questionGroup:count', id),
  moveQuestionsToGroup: (args: { fromGroupId: string; toGroupId: string }) =>
    invokeWithTimeout<number>('questionGroup:moveQuestions', args),
  syncGroupExamMeta: () =>
    invokeWithTimeout<{ updated: number; merged: number }>('questionGroup:syncExamMeta'),
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
  batchDeleteQuestions: (ids: string[]) =>
    invokeWithTimeout<{ deleted: number }>('question:batchDelete', ids),
  toggleFavorite: (id: string) =>
    invokeWithTimeout<{ is_favorite: number }>('question:toggleFavorite', id),
  getQuestionStats: () =>
    invokeWithTimeout<Record<string, unknown>>('question:getStats'),
  listKnowledgeTags: () =>
    invokeWithTimeout<string[]>('question:listTags'),
  exportQuestions: (args: { filter?: Record<string, unknown> }) =>
    invokeWithTimeout<{ count: number; filePath: string; imageCount?: number }>('question:export', args, 60_000),
  importQuestionsFile: (args: { group_id?: string | null; new_group?: unknown | null; group_type?: string }) =>
    invokeWithTimeout<{ count: number; imageCount?: number }>('question:importFile', args, 60_000),

  // Question images
  pickImageFile: () =>
    invokeWithTimeout<string | null>('app:pickImageFile'),
  uploadQuestionImage: (args: { question_id: string; field_name: string; source_path: string }) =>
    invokeWithTimeout<{ imageId: string; url: string }>('question:uploadImage', args),
  deleteQuestionImage: (args: { id: string }) =>
    invokeWithTimeout<boolean>('question:deleteImage', args),
  listQuestionImages: (args: { question_id: string }) =>
    invokeWithTimeout<unknown[]>('question:listImages', args),
  cleanupOrphanImages: () =>
    invokeWithTimeout<{ count: number }>('image:cleanupOrphans'),
  ensureLocalImage: (args: { url: string }) =>
    invokeWithTimeout<{ localUrl: string }>('image:ensureLocal', args, 30_000),

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
      engine?: string
      text: string
      detected_tables_count?: number
    }>('doc:preview', args, 60_000),
  importDocument: (args?: {
    filePath?: string
    topMarginRatio?: number
    bottomMarginRatio?: number
    startPage?: number
    endPage?: number | null
    extractTables?: boolean
    savePageImages?: boolean
    generateVisualSummary?: boolean
    visionMode?: 'disabled' | 'remote' | 'local'
  }) =>
    invokeWithTimeout<{ document: unknown; taskId?: string; duplicate?: boolean; reparsing?: boolean } | null>('doc:import', args, 60_000),
  openPath: (filePath: string) => invokeWithTimeout<void>('app:openPath', filePath),
  deleteDocument: (id: string) => invokeWithTimeout<void>('doc:delete', id),
  getDocChunks: (docId: string) => invokeWithTimeout<unknown[]>('doc:getChunks', docId),
  getDocAssets: (docId: string) => invokeWithTimeout<unknown[]>('doc:getAssets', docId),
  setDocumentOfficial: (args: { docId: string; isOfficial: boolean }) =>
    invokeWithTimeout<{ is_official: boolean }>('doc:setOfficial', args),
  searchDocChunks: (args: { query: string; limit?: number; docId?: string }) =>
    invokeWithTimeout<unknown[]>('doc:searchChunks', args),
  updateDocChunk: (chunkId: string, content: string) =>
    invokeWithTimeout<void>('doc:updateChunk', { chunkId, content }),
  reparsePage: (args: {
    filePath: string; docId: string; pageNum: number
    topMarginRatio?: number; bottomMarginRatio?: number
    reTables?: boolean; reVision?: boolean; savePageImages?: boolean
  }) =>
    invokeWithTimeout<unknown>('doc:reparsePage', args, 120_000),

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
  updateCrawlerRun: (args: { id: string; patch: Record<string, unknown> }) =>
    invokeWithTimeout<void>('crawler:updateRun', args),
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

  // ─── Study Plan Overhaul — Exam Config ──────────────────────────────────
  getExamConfig: () => invokeWithTimeout<unknown | null>('examConfig:get'),
  saveExamConfig: (args: unknown) => invokeWithTimeout<unknown>('examConfig:save', args),

  // ─── Study Plan Overhaul — Knowledge Domains ─────────────────────────────
  getDomainTree: () => invokeWithTimeout<unknown[]>('kd:tree'),
  getDomain: (id: string) => invokeWithTimeout<unknown | null>('kd:get', id),
  upsertDomain: (args: unknown) => invokeWithTimeout<unknown>('kd:upsert', args),
  deleteDomain: (id: string) => invokeWithTimeout<{ deleted: number }>('kd:delete', id),
  importOutline: (args?: { force?: boolean }) =>
    invokeWithTimeout<{ imported: number; skipped: number }>('kd:importOutline', args ?? {}),
  mapDocToDomain: (args: unknown) => invokeWithTimeout<unknown[]>('kd:mapDoc', args),
  getFlatDomainList: () => invokeWithTimeout<unknown[]>('kd:flatList'),
  batchUpsertDomains: (args: { domains: unknown[] }) =>
    invokeWithTimeout<{ inserted: number; updated: number }>('kd:batchUpsert', args),
  getChunksForDocuments: (args: { docIds: string[] }) =>
    invokeWithTimeout<unknown[]>('kd:getChunksForDocs', args),
  extractKnowledgePoints: (args: { docIds: string[] }) =>
    invokeWithTimeout<{ suggestions: unknown[] }>('ai:extractKnowledge', args, 300_000),
  onExtractKnowledgeProgress: (cb: (msg: { message: string }) => void) => {
    const handler = (_: unknown, msg: { message: string }) => cb(msg)
    ipcRenderer.on('ai:extractKnowledge:progress', handler)
    return () => ipcRenderer.removeListener('ai:extractKnowledge:progress', handler)
  },

  // ─── Study Plan Overhaul — Learning Logs ─────────────────────────────────
  createLog: (args: unknown) => invokeWithTimeout<unknown>('log:create', args),
  queryLogs: (args: { from: string; to: string }) => invokeWithTimeout<unknown[]>('log:query', args),
  getLogStats: (args?: { days?: number }) => invokeWithTimeout<unknown>('log:stats', args),
  updateLog: (args: { id: string; changes: unknown }) => invokeWithTimeout<unknown | null>('log:update', args),
  deleteLog: (id: string) => invokeWithTimeout<void>('log:delete', id),

  // ─── Study Plan Overhaul — Enhanced Plan Operations ──────────────────────
  generatePhasedPlan: (args: { planId: string; examDate: string }) =>
    invokeWithTimeout<{ tasksCreated: number }>('plan:generatePhased', args),
  lockDays: (args: { planId: string; fromDate: string; toDate: string }) =>
    invokeWithTimeout<{ locked: number }>('plan:lockDays', args),
  unlockDays: (args: { planId: string; fromDate: string; toDate: string }) =>
    invokeWithTimeout<{ unlocked: number }>('plan:unlockDays', args),
  resetPlan: (args: { planId: string; keepLogs?: boolean }) =>
    invokeWithTimeout<void>('plan:reset', args),
  addCustomTask: (args: { planId: string; task: unknown }) =>
    invokeWithTimeout<unknown>('plan:addCustomTask', args),
  moveTask: (args: { taskId: string; newDate: string }) =>
    invokeWithTimeout<void>('plan:moveTask', args),
  skipDay: (args: { planId: string; skipDate: string }) =>
    invokeWithTimeout<{ distributed: number }>('plan:skipDay', args),
  relinkPlanDocs: (planId: string) =>
    invokeWithTimeout<{ scanned: number; linked: number }>('plan:relinkDocs', planId),
  remapChunkTags: () =>
    invokeWithTimeout<{ total: number; updated: number }>('plan:remapChunkTags'),
  applyAiSchedule: (args: { planId: string; dailySchedule: unknown[] }) =>
    invokeWithTimeout<{ tasksCreated: number }>('plan:applyAiSchedule', args),

  // ─── Study Plan Overhaul — Plan Templates ────────────────────────────────
  listTemplates: () => invokeWithTimeout<unknown[]>('template:list'),
  createTemplate: (args: unknown) => invokeWithTimeout<unknown>('template:create', args),
  deleteTemplate: (id: string) => invokeWithTimeout<void>('template:delete', id),
  applyTemplate: (args: { planId: string; templateId: string }) =>
    invokeWithTimeout<{ tasksCreated: number }>('template:apply', args),

  // ─── Sprint Mode ─────────────────────────────────────────────────────────
  getSprintStatus: () => invokeWithTimeout<unknown>('sprint:status'),
  activateSprintMode: (planId: string) => invokeWithTimeout<void>('sprint:activate', planId),
  getDailyCard: () => invokeWithTimeout<unknown>('sprint:dailyCard'),

  // ─── Pomodoro Enhanced ───────────────────────────────────────────────────
  getFocusStats: (args?: { days?: number }) => invokeWithTimeout<unknown>('session:getFocusStats', args),
  reportInterruption: (sessionId: string) => invokeWithTimeout<void>('session:reportInterruption', { sessionId }),

  // ─── AI Study Plan ───────────────────────────────────────────────────────
  aiPlanAdvice: (args: unknown) =>
    invokeWithTimeout<{ advice: string; suggested_tasks: unknown[] }>('ai:planAdvice', args, 60_000),
  aiGeneratePlanTemplate: (args: unknown) =>
    invokeWithTimeout<{ template: unknown }>('ai:generatePlanTemplate', args, 60_000),
  aiEssayMaterialMatch: (args: unknown) =>
    invokeWithTimeout<{ matches: unknown[] }>('ai:essayMaterialMatch', args, 30_000),
  aiDailyRecommendation: (args: unknown) =>
    invokeWithTimeout<{ recommended_task: unknown; reason: string }>('ai:dailyRecommendation', args, 30_000),
  aiGenerateStudyPlan: (args: unknown) =>
    invokeWithTimeout<{ plan_name: string; daily_schedule: unknown[]; total_days: number }>('ai:generateStudyPlan', args, 120_000),
  aiOptimizePlan: (args: unknown) =>
    invokeWithTimeout<{ daily_schedule: unknown[]; total_days: number }>('ai:optimizePlan', args, 120_000),

  // ─── Notifications ───────────────────────────────────────────────────────
  listNotifications: (args?: { isRead?: number; limit?: number }) =>
    invokeWithTimeout<unknown[]>('notification:list', args),
  markNotificationRead: (id?: string) =>
    invokeWithTimeout<void>('notification:markRead', { id }),
  checkNotificationTriggers: () => invokeWithTimeout<unknown[]>('notification:checkTriggers'),
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
