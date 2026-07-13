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
  text: string
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
