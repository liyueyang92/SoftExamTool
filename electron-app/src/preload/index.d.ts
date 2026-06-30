import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    electronAPI: {
      ping: () => Promise<{ success: boolean; data?: string; error?: string }>
      onPythonStatus: (cb: (status: { ready: boolean }) => void) => () => void
    }
  }
}
