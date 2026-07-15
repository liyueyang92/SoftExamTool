// Shared type definitions used by both preload and renderer.
// Kept in a plain .ts file so bundler-mode moduleResolution can import it.

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
  // Migration 19 extended fields
  task_type?: 'reading' | 'video' | 'practice' | 'review' | 'essay' | 'mock_exam' | 'custom'
  priority?: number
  estimated_min?: number
  actual_min?: number | null
  doc_id?: string | null
  doc_page_range?: string | null
  linked_doc_ids?: string
  linked_question_ids?: string
  linked_essay_id?: string | null
  locked?: number
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

export interface PdfImportSelection {
  filePath: string
  fileName: string
  title: string
}

export interface PdfImportOptions {
  filePath?: string
  topMarginRatio?: number
  bottomMarginRatio?: number
  startPage?: number
  endPage?: number | null
  extractTables?: boolean
  savePageImages?: boolean
  generateVisualSummary?: boolean
  visionMode?: 'disabled' | 'remote' | 'local'
}

export interface PdfImportResult {
  document: unknown
  taskId?: string
  duplicate?: boolean
  reparsing?: boolean
}

export interface PdfPreviewResult {
  page_count: number
  preview_page: number
  crop_ratios: {
    top_margin_ratio: number
    bottom_margin_ratio: number
  }
  crop_bbox: {
    x0: number
    top: number
    x1: number
    bottom: number
  }
  engine?: string
  text: string
  detected_tables_count?: number
  detected_figures_count?: number
}

export interface StoragePathsInfo {
  bootstrapConfigPath: string
  dataRootDir: string
  defaultDataRootDir: string
  aiConfigPath: string
  appSettingsPath: string
  databasePath: string
  documentLibraryDir: string
  imageDir: string
  backupDir: string
  customDataRootDir: string
  usingCustomDataRoot: boolean
}

export interface StoragePathsUpdateResult {
  paths: StoragePathsInfo
  restartRequired: boolean
}

// ─── Phase 1 study plan overhaul: new types ────────────────────────────────────

export interface ExamConfig {
  id: string
  exam_name: string
  exam_date: string | null
  syllabus_version: string
  target_score: number
  daily_min_minutes: number
  daily_max_minutes: number
  study_start_time: string
  created_at: string
  updated_at: string
}

export interface KnowledgeDomain {
  id: string
  parent_id: string | null
  name: string
  level: number
  sort_order: number
  suggested_min: number
  weight_pct: number
  is_required: number
  outline_ref: string
  created_at: string
}

export interface KnowledgeDomainTreeNode extends KnowledgeDomain {
  children: KnowledgeDomainTreeNode[]
}

export interface LearningLog {
  id: string
  log_date: string
  time_slot: 'morning' | 'afternoon' | 'evening'
  task_id: string | null
  focus_minutes: number
  pomodoro_cycles: number
  interruption_count: number
  self_rating: number | null
  notes: string
  created_at: string
}

export interface DailyLogStats {
  date: string
  total_focus_minutes: number
  total_pomodoro_cycles: number
  total_interruptions: number
  avg_self_rating: number | null
}

export interface PlanTemplate {
  id: string
  name: string
  description: string
  phase: 'foundation' | 'reinforcement' | 'sprint'
  task_rules_json: string
  is_builtin: number
  created_at: string
}

export interface SprintStatus {
  isActive: boolean
  daysUntilExam: number | null
  dailyCardsReady: boolean
  essayDueToday: boolean
}

export interface SprintCardItem {
  tag: string
  keyPoints: string[]
  relatedErrorCount: number
}

export interface SprintCard {
  date: string
  items: SprintCardItem[]
  generatedAt: string
}

export interface Notification {
  id: string
  type: 'daily_plan' | 'progress_warning' | 'streak_milestone' | 'countdown' | 'pomodoro_end' | 'achievement' | 'system'
  title: string
  body: string
  action_url: string | null
  is_read: number
  created_at: string
}

export interface FocusStats {
  totalSessions: number
  totalPomodoros: number
  avgFocusMinutes: number
  avgInterruptionsPerSession: number
  avgFocusRating: number | null
  bestTimeSlot: string
  dailyBreakdown: Array<{
    date: string
    focusMinutes: number
    pomodoros: number
    interruptions: number
  }>
}
