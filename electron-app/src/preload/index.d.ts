import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  Achievement,
  AdaptAdjustment,
  BackupRecord,
  CalendarDay,
  DailyLogStats,
  ExamConfig,
  FocusStats,
  IpcResponse,
  KnowledgeDomain,
  KnowledgeDomainTreeNode,
  LearningLog,
  Notification,
  PdfImportOptions,
  PdfImportResult,
  PdfImportSelection,
  PdfPreviewResult,
  PlanStats,
  PlanTask,
  PlanTemplate,
  ProgressMessage,
  SprintCard,
  SprintStatus,
  StoragePathsInfo,
  StoragePathsUpdateResult,
  StudyPlan,
  StudySession,
  Task,
} from './shared-types'

export type {
  Achievement,
  AdaptAdjustment,
  BackupRecord,
  CalendarDay,
  DailyLogStats,
  ExamConfig,
  FocusStats,
  IpcResponse,
  KnowledgeDomain,
  KnowledgeDomainTreeNode,
  LearningLog,
  Notification,
  PdfImportOptions,
  PdfImportResult,
  PdfImportSelection,
  PdfPreviewResult,
  PlanStats,
  PlanTask,
  PlanTemplate,
  ProgressMessage,
  SprintCard,
  SprintStatus,
  StoragePathsInfo,
  StoragePathsUpdateResult,
  StudyPlan,
  StudySession,
  Task,
} from './shared-types'

declare global {
  interface Window {
    electron: ElectronAPI
    electronAPI: {
      ping: () => Promise<IpcResponse<string>>
      onPythonStatus: (cb: (status: { ready: boolean }) => void) => () => void
      getPythonStatus: () => Promise<IpcResponse<{ ready: boolean }>>

      getDbStatus: () => Promise<IpcResponse<{ ready: boolean; version: number }>>
      clearAllData: () => Promise<IpcResponse<{ count: number }>>

      createTask: (args: { type: string; payload: unknown }) => Promise<IpcResponse<{ id: string }>>
      getTask: (id: string) => Promise<IpcResponse<Task | null>>
      cancelTask: (id: string) => Promise<IpcResponse<void>>
      onTaskProgress: (cb: (msg: ProgressMessage) => void) => () => void
      onTaskPartial: (cb: (data: {
        taskId: string; pageNum: number; totalPages: number
        chunks: unknown[]; assets: unknown[]; warnings: unknown[]
      }) => void) => () => void

      getSettings: () => Promise<IpcResponse<Record<string, unknown>>>
      setSetting: (args: { key: string; value: unknown }) => Promise<IpcResponse<void>>
      getStoragePaths: () => Promise<IpcResponse<StoragePathsInfo>>
      setStoragePaths: (args: { dataRootDir?: string }) => Promise<IpcResponse<StoragePathsUpdateResult>>
      pickDirectory: (args?: { title?: string; defaultPath?: string }) => Promise<IpcResponse<string | null>>
      relaunchApp: () => Promise<IpcResponse<void>>

      listQuestionGroups: () => Promise<IpcResponse<unknown[]>>
      upsertQuestionGroup: (args: unknown) => Promise<IpcResponse<unknown>>
      deleteQuestionGroup: (id: string) => Promise<IpcResponse<void>>
      countQuestionsInGroup: (id: string) => Promise<IpcResponse<number>>
      moveQuestionsToGroup: (args: { fromGroupId: string; toGroupId: string }) => Promise<IpcResponse<number>>
      syncGroupExamMeta: () => Promise<IpcResponse<{ updated: number; merged: number }>>
      queryQuestions: (filter?: Record<string, unknown>) => Promise<IpcResponse<{ items: unknown[]; total: number }>>
      searchQuestions: (args: { q: string; limit?: number }) => Promise<IpcResponse<unknown[]>>
      insertQuestion: (q: unknown) => Promise<IpcResponse<unknown>>
      batchInsertQuestions: (args: { questions: unknown[] }) => Promise<IpcResponse<{ count: number }>>
      updateQuestion: (args: { id: string; changes: unknown }) => Promise<IpcResponse<void>>
      deleteQuestion: (id: string) => Promise<IpcResponse<void>>
      batchDeleteQuestions: (ids: string[]) => Promise<IpcResponse<{ deleted: number }>>
      toggleFavorite: (id: string) => Promise<IpcResponse<{ is_favorite: number }>>
      getQuestionStats: () => Promise<IpcResponse<Record<string, unknown>>>
      listKnowledgeTags: () => Promise<IpcResponse<string[]>>
      exportQuestions: (args: { filter?: Record<string, unknown> }) => Promise<IpcResponse<{ count: number; filePath: string; imageCount?: number }>>
      importQuestionsFile: (args: { group_id?: string | null; new_group?: unknown | null; group_type?: string }) => Promise<IpcResponse<{ count: number; imageCount?: number }>>

      pickImageFile: () => Promise<IpcResponse<string | null>>
      uploadQuestionImage: (args: { question_id: string; field_name: string; source_path: string }) => Promise<IpcResponse<{ imageId: string; url: string }>>
      deleteQuestionImage: (args: { id: string }) => Promise<IpcResponse<boolean>>
      listQuestionImages: (args: { question_id: string }) => Promise<IpcResponse<unknown[]>>
      cleanupOrphanImages: () => Promise<IpcResponse<{ count: number }>>
      ensureLocalImage: (args: { url: string }) => Promise<IpcResponse<{ localUrl: string }>>

      startPractice: (config: unknown) => Promise<IpcResponse<{ sessionId: string; questions: unknown[] }>>
      submitAnswer: (args: { sessionId: string; questionId: string; chosen: string; timeMs: number }) => Promise<IpcResponse<{ isCorrect: boolean; answer: string | null; explanation: string | null; nextIndex: number }>>
      endPractice: (sessionId: string) => Promise<IpcResponse<{ totalCount: number; correctCount: number; durationMs: number }>>
      getWrongQuestions: (args?: { limit?: number }) => Promise<IpcResponse<unknown[]>>

      listDocuments: () => Promise<IpcResponse<unknown[]>>
      pickDocumentFile: () => Promise<IpcResponse<PdfImportSelection | null>>
      previewDocumentImport: (args: {
        filePath: string
        previewPage: number
        topMarginRatio?: number
        bottomMarginRatio?: number
      }) => Promise<IpcResponse<PdfPreviewResult>>
      importDocument: (args?: PdfImportOptions) => Promise<IpcResponse<PdfImportResult | null>>
      openPath: (filePath: string) => Promise<IpcResponse<void>>
      deleteDocument: (id: string) => Promise<IpcResponse<void>>
      getDocChunks: (docId: string) => Promise<IpcResponse<unknown[]>>
      getDocAssets: (docId: string) => Promise<IpcResponse<unknown[]>>
      setDocumentOfficial: (args: { docId: string; isOfficial: boolean }) => Promise<IpcResponse<{ is_official: boolean }>>
      searchDocChunks: (args: { query: string; limit?: number; docId?: string }) => Promise<IpcResponse<unknown[]>>
      updateDocChunk: (chunkId: string, content: string) => Promise<IpcResponse<void>>
      reparsePage: (args: {
        filePath: string; docId: string; pageNum: number
        topMarginRatio?: number; bottomMarginRatio?: number
        reTables?: boolean; reVision?: boolean; savePageImages?: boolean
      }) => Promise<IpcResponse<unknown>>

      getAiConfig: () => Promise<IpcResponse<Record<string, unknown>>>
      setAiConfig: (args: unknown) => Promise<IpcResponse<void>>
      testAiConnection: (args?: unknown) => Promise<IpcResponse<{ ok: boolean; reply: string }>>
      generateQuestions: (args: unknown) => Promise<IpcResponse<{ questions: unknown[]; target_group_id?: string | null; new_group?: unknown | null }>>
      gradeEssay: (args: unknown) => Promise<IpcResponse<unknown>>
      aiGenerateStudyPlan: (args: unknown) => Promise<IpcResponse<{ plan_name: string; daily_schedule: unknown[]; total_days: number }>>
      aiOptimizePlan: (args: unknown) => Promise<IpcResponse<{ daily_schedule: unknown[]; total_days: number }>>

      listCrawlerRules: () => Promise<IpcResponse<unknown[]>>
      upsertCrawlerRule: (args: unknown) => Promise<IpcResponse<unknown>>
      deleteCrawlerRule: (id: string) => Promise<IpcResponse<void>>
      testCrawl: (args: unknown) => Promise<IpcResponse<{ count: number; samples: unknown[] }>>
      runCrawl: (args: { ruleId: string; account_alias?: string | null }) => Promise<IpcResponse<{ taskId: string; runId: string }>>
      listCrawlerRuns: (ruleId: string) => Promise<IpcResponse<unknown[]>>
      deleteCrawlerRun: (id: string) => Promise<IpcResponse<void>>
      updateCrawlerRun: (args: { id: string; patch: Record<string, unknown> }) => Promise<IpcResponse<void>>
      startCrawlerAuth: (args: { ruleId: string; account_alias?: string }) => Promise<IpcResponse<{
        id: string
        site_id: string
        site_name: string
        account_alias: string
        auth_mode: string
        storage_meta: Record<string, unknown>
        last_validated_at: string | null
        expires_at: string | null
        created_at: string
        updated_at: string
      }>>
      openCrawlerVisualConfig: (args: { ruleId: string; account_alias?: string }) => Promise<IpcResponse<unknown>>
      listCrawlerSessions: (args?: { ruleId?: string }) => Promise<IpcResponse<unknown[]>>
      validateCrawlerSession: (args: { ruleId: string; account_alias: string }) => Promise<IpcResponse<{ valid: boolean; status?: number; message?: string; checks?: Array<{ name: string; valid: boolean; message: string }> }>>
      deleteCrawlerSession: (args: { ruleId: string; account_alias: string }) => Promise<IpcResponse<void>>
      listCrawlerReviewItems: (args?: { status?: string; ruleId?: string; runId?: string; limit?: number }) => Promise<IpcResponse<unknown[]>>
      rejectCrawlerReviewItems: (args: { ids: string[]; notes?: string }) => Promise<IpcResponse<void>>
      importCrawlerReviewItems: (args: { ids: string[]; target_group_id?: string | null; new_group?: unknown | null }) => Promise<IpcResponse<{ count: number }>>
      inspectCrawlerLoad: (args: unknown) => Promise<IpcResponse<unknown>>
      inspectCrawlerPreview: (args: unknown) => Promise<IpcResponse<unknown>>
      suggestCrawlerSelector: (args: unknown) => Promise<IpcResponse<unknown>>
      getCrawlerRuntimeStatus: () => Promise<IpcResponse<unknown>>

      buildGraph: () => Promise<IpcResponse<{ nodes: unknown[]; edges: unknown[] }>>

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

      aiChat: (args: { sessionId: string; question: string; useDocContext?: boolean }) => Promise<IpcResponse<{ answer: string; sources: unknown[] }>>
      listAiChatSessions: (args?: { limit?: number }) => Promise<IpcResponse<unknown[]>>
      createAiChatSession: (args?: { title?: string }) => Promise<IpcResponse<unknown>>
      deleteAiChatSession: (sessionId: string) => Promise<IpcResponse<void>>
      listAiChatMessages: (args: { sessionId: string; limit?: number }) => Promise<IpcResponse<unknown[]>>

      getPlanActive: () => Promise<IpcResponse<StudyPlan | null>>
      createPlan: (args: { examDate: string; mode: 'normal' | 'sprint'; config?: Record<string, unknown> }) => Promise<IpcResponse<StudyPlan>>
      deletePlan: (id: string) => Promise<IpcResponse<void>>
      getPlanTasks: (args: { planId: string; dateFrom?: string; dateTo?: string }) => Promise<IpcResponse<PlanTask[]>>
      updatePlanTask: (args: { taskId: string; changes: { status?: string; actual_count?: number } }) => Promise<IpcResponse<void>>
      getPlanStats: (planId: string) => Promise<IpcResponse<PlanStats>>
      getPlanCalendar: (args: { planId: string; year: number; month: number }) => Promise<IpcResponse<CalendarDay[]>>
      adaptPlan: (planId: string) => Promise<IpcResponse<{ adjustments: AdaptAdjustment[] }>>

      startSession: (args?: { type?: 'manual' | 'pomodoro'; planTaskId?: string }) => Promise<IpcResponse<StudySession>>
      endSession: (args: { id: string; durationMs: number }) => Promise<IpcResponse<void>>
      getTodaySessions: () => Promise<IpcResponse<StudySession[]>>

      listAchievements: () => Promise<IpcResponse<Achievement[]>>
      checkAchievements: () => Promise<IpcResponse<Achievement[]>>
      onAchievementUnlocked: (cb: (achievements: Achievement[]) => void) => () => void

      listBackups: () => Promise<IpcResponse<BackupRecord[]>>
      createBackup: (args?: { note?: string }) => Promise<IpcResponse<BackupRecord>>
      restoreBackup: () => Promise<IpcResponse<{ restored: boolean }>>
      deleteBackup: (id: string) => Promise<IpcResponse<void>>

      // ─── Study Plan Overhaul — Exam Config ──────────────────────────────
      getExamConfig: () => Promise<IpcResponse<ExamConfig | null>>
      saveExamConfig: (args: Omit<ExamConfig, 'id' | 'created_at' | 'updated_at'>) => Promise<IpcResponse<ExamConfig>>

      // ─── Study Plan Overhaul — Knowledge Domains ─────────────────────────
      getDomainTree: () => Promise<IpcResponse<KnowledgeDomainTreeNode[]>>
      getDomain: (id: string) => Promise<IpcResponse<KnowledgeDomain | null>>
      upsertDomain: (args: Omit<KnowledgeDomain, 'created_at'>) => Promise<IpcResponse<KnowledgeDomain>>
      deleteDomain: (id: string) => Promise<IpcResponse<{ deleted: number }>>
      importOutline: (args?: { force?: boolean }) => Promise<IpcResponse<{ imported: number; skipped: number }>>
      mapDocToDomain: (args: { domainId: string; docId: string; pageRange: string }) => Promise<IpcResponse<Array<{ doc_id: string; page_range: string }>>>
      getFlatDomainList: () => Promise<IpcResponse<Array<{ id: string; parent_id: string | null; name: string; level: number }>>>
      batchUpsertDomains: (args: { domains: Array<Omit<KnowledgeDomain, 'created_at'>> }) => Promise<IpcResponse<{ inserted: number; updated: number }>>
      getChunksForDocuments: (args: { docIds: string[] }) => Promise<IpcResponse<Array<{ id: string; doc_id: string; page_num: number; content: string; knowledge_tags: string }>>>
      extractKnowledgePoints: (args: { docIds: string[] }) => Promise<IpcResponse<{ suggestions: Array<{ name: string; suggested_parent_id: string; suggested_parent_name: string; summary: string; source_chunk_ids: string[]; confidence: number }> }>>
      onExtractKnowledgeProgress: (cb: (msg: { message: string }) => void) => () => void

      // ─── Study Plan Overhaul — Learning Logs ─────────────────────────────
      createLog: (args: Omit<LearningLog, 'id' | 'created_at'>) => Promise<IpcResponse<LearningLog>>
      queryLogs: (args: { from: string; to: string }) => Promise<IpcResponse<LearningLog[]>>
      getLogStats: (args?: { days?: number }) => Promise<IpcResponse<DailyLogStats[]>>
      updateLog: (args: { id: string; changes: Partial<Omit<LearningLog, 'id' | 'created_at'>> }) => Promise<IpcResponse<LearningLog | null>>
      deleteLog: (id: string) => Promise<IpcResponse<void>>

      // ─── Enhanced Plan Operations ──────────────────────────────────────
      generatePhasedPlan: (args: { planId: string; examDate: string }) => Promise<IpcResponse<{ tasksCreated: number }>>
      lockDays: (args: { planId: string; fromDate: string; toDate: string }) => Promise<IpcResponse<{ locked: number }>>
      unlockDays: (args: { planId: string; fromDate: string; toDate: string }) => Promise<IpcResponse<{ unlocked: number }>>
      resetPlan: (args: { planId: string; keepLogs?: boolean }) => Promise<IpcResponse<void>>
      addCustomTask: (args: { planId: string; task: unknown }) => Promise<IpcResponse<PlanTask>>
      moveTask: (args: { taskId: string; newDate: string }) => Promise<IpcResponse<void>>
      skipDay: (args: { planId: string; skipDate: string }) => Promise<IpcResponse<{ distributed: number }>>
      relinkPlanDocs: (planId: string) => Promise<IpcResponse<{ scanned: number; linked: number }>>
      remapChunkTags: () => Promise<IpcResponse<{ total: number; updated: number }>>
      applyAiSchedule: (args: { planId: string; dailySchedule: unknown[] }) => Promise<IpcResponse<{ tasksCreated: number }>>

      // ─── Plan Templates ────────────────────────────────────────────────
      listTemplates: () => Promise<IpcResponse<PlanTemplate[]>>
      createTemplate: (args: Omit<PlanTemplate, 'id' | 'created_at'>) => Promise<IpcResponse<PlanTemplate>>
      deleteTemplate: (id: string) => Promise<IpcResponse<void>>
      applyTemplate: (args: { planId: string; templateId: string }) => Promise<IpcResponse<{ tasksCreated: number }>>

      // ─── Sprint Mode ────────────────────────────────────────────────────
      getSprintStatus: () => Promise<IpcResponse<SprintStatus>>
      activateSprintMode: (planId: string) => Promise<IpcResponse<void>>
      getDailyCard: () => Promise<IpcResponse<SprintCard>>

      // ─── Pomodoro Enhanced ──────────────────────────────────────────────
      getFocusStats: (args?: { days?: number }) => Promise<IpcResponse<FocusStats>>
      reportInterruption: (sessionId: string) => Promise<IpcResponse<void>>

      // ─── Notifications ──────────────────────────────────────────────────
      listNotifications: (args?: { isRead?: number; limit?: number }) => Promise<IpcResponse<Notification[]>>
      markNotificationRead: (id?: string) => Promise<IpcResponse<void>>
      checkNotificationTriggers: () => Promise<IpcResponse<Notification[]>>
    }
  }
}
