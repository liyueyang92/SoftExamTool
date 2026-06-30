import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const customAPI = {
  ping: (): Promise<{ success: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke('ping'),
  onPythonStatus: (cb: (status: { ready: boolean }) => void) => {
    ipcRenderer.on('python:status', (_, status) => cb(status))
    return () => ipcRenderer.removeAllListeners('python:status')
  }
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
