import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toIpcPayload } from '../utils/ipc'

export const useAppStore = defineStore('app', () => {
  const pythonReady = ref(false)
  const dbReady = ref(false)
  const dbVersion = ref(0)
  const darkMode = ref(true)

  function setPythonReady(ready: boolean) {
    pythonReady.value = ready
  }

  function setDbStatus(ready: boolean, version: number) {
    dbReady.value = ready
    dbVersion.value = version
  }

  async function toggleDarkMode() {
    darkMode.value = !darkMode.value
    try {
      await window.electronAPI.setSetting(toIpcPayload({ key: 'darkMode', value: darkMode.value }))
    } catch {
      // non-critical
    }
    applyDarkMode()
  }

  function applyDarkMode() {
    document.documentElement.classList.toggle('dark', darkMode.value)
  }

  async function init() {
    // Listen for future Python status pushes
    window.electronAPI.onPythonStatus((status) => {
      setPythonReady(status.ready)
      if (status.ready) loadDbStatus()
    })

    // Query current state immediately — the push event may have fired before this
    // listener was registered (race: Python already ready when renderer mounted).
    try {
      const res = await window.electronAPI.getPythonStatus()
      if (res.success && res.data.ready && !pythonReady.value) {
        setPythonReady(true)
        await loadDbStatus()
      }
    } catch {
      // non-critical, push event will cover it
    }

    // Load persisted settings
    try {
      const res = await window.electronAPI.getSettings()
      if (res.success && res.data.darkMode !== undefined) {
        darkMode.value = res.data.darkMode as boolean
      }
    } catch {
      // use default
    }
    applyDarkMode()
  }

  async function loadDbStatus() {
    try {
      const res = await window.electronAPI.getDbStatus()
      if (res.success) setDbStatus(res.data.ready, res.data.version)
    } catch {
      // non-critical
    }
  }

  return { pythonReady, dbReady, dbVersion, darkMode, setPythonReady, setDbStatus, toggleDarkMode, init }
})
