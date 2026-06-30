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
    invokeWithTimeout<{ id: string; type: string; status: string; result: unknown } | null>(
      'task:get', id
    ),
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
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('electronAPI', customAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (fallback for non-isolated context)
  window.electron = electronAPI
  // @ts-ignore
  window.electronAPI = customAPI
}
