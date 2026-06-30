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
    }
  }
}
