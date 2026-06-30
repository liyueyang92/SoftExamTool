import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { PythonManager } from './python-manager'
import { IPC } from './ipc-channels'
import { verifySQLCipher } from './db/verify'
import { initDatabase, getDatabase, closeDatabase } from './db/index'
import { TaskManager } from './task-manager'
import { WsProgressClient } from './ws-client'
import { registerHandler } from './ipc-handler'

const pythonManager = new PythonManager()
const wsClient = new WsProgressClient()
let taskManager: TaskManager | null = null
let mainWindow: BrowserWindow | null = null

// In-memory app settings (persisted to userData/settings.json in Phase 2+)
const appSettings: Record<string, unknown> = {}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpcHandlers(): void {
  // Phase 0
  registerHandler(IPC.PING, async () => {
    const msg = await pythonManager.ping()
    return msg
  })

  // Phase 1 — DB status
  registerHandler(IPC.DB_STATUS, async () => {
    const db = getDatabase()
    const version = db.pragma('user_version', { simple: true }) as number
    return { ready: true, version }
  })

  // Phase 1 — Task CRUD
  registerHandler(IPC.TASK_CREATE, async (args) => {
    const { type, payload } = args as { type: string; payload: unknown }
    const id = taskManager!.createTask(type, payload)
    // open a WebSocket progress channel for this task
    wsClient.connect(id)
    return { id }
  })

  registerHandler(IPC.TASK_GET, async (id) => {
    return taskManager!.getTask(id as string) ?? null
  })

  registerHandler(IPC.TASK_CANCEL, async (id) => {
    taskManager!.cancelTask(id as string)
    wsClient.disconnect(id as string)
  })

  // Phase 1 — App settings
  registerHandler(IPC.APP_GET_SETTINGS, async () => ({ ...appSettings }))

  registerHandler(IPC.APP_SET_SETTING, async (args) => {
    const { key, value } = args as { key: string; value: unknown }
    appSettings[key] = value
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.softexam')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Phase 0: verify SQLCipher (keep for regression safety)
  verifySQLCipher()

  // Phase 1: init encrypted database
  try {
    const db = await initDatabase()
    taskManager = new TaskManager(db)
    taskManager.recoverOrphanedTasks()
    console.log('[App] Database ready')
  } catch (e) {
    console.error('[App] Database init failed:', e)
  }

  mainWindow = createWindow()

  // Phase 1: start Python and wire WebSocket client
  pythonManager.start(mainWindow).then(() => {
    wsClient.init(pythonManager.port, pythonManager.token, mainWindow!)
    console.log('[App] Python ready, WS client initialized')
  }).catch((e) => {
    console.error('[Python] failed to start:', e)
  })

  registerIpcHandlers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  wsClient.disconnectAll()
  pythonManager.stop()
  closeDatabase()
  if (process.platform !== 'darwin') app.quit()
})
