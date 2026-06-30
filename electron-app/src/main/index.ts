import { app, shell, BrowserWindow, dialog, safeStorage } from 'electron'
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
import {
  queryQuestions, searchQuestions, insertQuestion, batchInsertQuestions,
  updateQuestion, deleteQuestion, toggleFavorite, getQuestionStats, getWrongQuestions
} from './db/questions'
import { startPractice, submitAnswer, endPractice } from './db/practice'
import {
  listDocuments, getDocumentByMd5, insertDocument, updateDocumentPageCount,
  deleteDocument, insertChunks, getChunks
} from './db/documents'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join as pathJoin } from 'path'

const pythonManager = new PythonManager()
const wsClient = new WsProgressClient()
let taskManager: TaskManager | null = null
let mainWindow: BrowserWindow | null = null

// AI config (persisted to userData/ai-config.json; API key via safeStorage)
let aiConfig: Record<string, unknown> = {
  mode: 'openai',
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5' },
}

function getAiConfigPath(): string {
  return pathJoin(app.getPath('userData'), 'ai-config.json')
}

function loadAiConfig(): void {
  const p = getAiConfigPath()
  if (!existsSync(p)) return
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw)
    aiConfig = { ...aiConfig, ...parsed }
  } catch { /* use defaults */ }
}

function saveAiConfig(): void {
  try {
    writeFileSync(getAiConfigPath(), JSON.stringify(aiConfig, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

function buildProviderConfig(): Record<string, unknown> {
  const cfg = { ...aiConfig }
  // Decrypt API key if stored
  const encKey = (cfg as Record<string, Record<string, unknown>>).openai?.encryptedApiKey as Buffer | undefined
  if (encKey && safeStorage.isEncryptionAvailable()) {
    try {
      const key = safeStorage.decryptString(Buffer.from(encKey))
      ;(cfg as Record<string, Record<string, unknown>>).openai = {
        ...(cfg as Record<string, Record<string, unknown>>).openai,
        apiKey: key,
      }
    } catch { /* use empty key */ }
  }
  return cfg
}

// In-memory app settings
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
  const db = getDatabase()

  // Phase 0
  registerHandler(IPC.PING, async () => pythonManager.ping())

  // Phase 1 — DB status
  registerHandler(IPC.DB_STATUS, async () => {
    const version = db.pragma('user_version', { simple: true }) as number
    return { ready: true, version }
  })

  // Phase 1 — Task CRUD
  registerHandler(IPC.TASK_CREATE, async (args) => {
    const { type, payload } = args as { type: string; payload: unknown }
    const id = taskManager!.createTask(type, payload)
    wsClient.connect(id)
    return { id }
  })
  registerHandler(IPC.TASK_GET, async (id) => taskManager!.getTask(id as string) ?? null)
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

  // Phase 2 — Questions
  registerHandler(IPC.QUESTION_QUERY, async (args) => {
    return queryQuestions(db, args as Parameters<typeof queryQuestions>[1])
  })
  registerHandler(IPC.QUESTION_SEARCH, async (args) => {
    const { q, limit } = args as { q: string; limit?: number }
    return searchQuestions(db, q, limit)
  })
  registerHandler(IPC.QUESTION_INSERT, async (args) => insertQuestion(db, args as Parameters<typeof insertQuestion>[1]))
  registerHandler(IPC.QUESTION_BATCH_INSERT, async (args) => {
    const { questions } = args as { questions: Parameters<typeof batchInsertQuestions>[1] }
    return { count: batchInsertQuestions(db, questions) }
  })
  registerHandler(IPC.QUESTION_UPDATE, async (args) => {
    const { id, changes } = args as { id: string; changes: Parameters<typeof updateQuestion>[2] }
    updateQuestion(db, id, changes)
  })
  registerHandler(IPC.QUESTION_DELETE, async (id) => deleteQuestion(db, id as string))
  registerHandler(IPC.QUESTION_TOGGLE_FAVORITE, async (id) => ({ is_favorite: toggleFavorite(db, id as string) }))
  registerHandler(IPC.QUESTION_GET_STATS, async () => getQuestionStats(db))

  // Phase 2 — Practice
  registerHandler(IPC.PRACTICE_START, async (args) => startPractice(db, args as Parameters<typeof startPractice>[1]))
  registerHandler(IPC.PRACTICE_SUBMIT_ANSWER, async (args) => {
    const { sessionId, questionId, chosen, timeMs } = args as {
      sessionId: string; questionId: string; chosen: string; timeMs: number
    }
    return submitAnswer(db, sessionId, questionId, chosen, timeMs)
  })
  registerHandler(IPC.PRACTICE_END, async (sessionId) => endPractice(db, sessionId as string))
  registerHandler(IPC.PRACTICE_GET_WRONG, async (args) => {
    const { limit } = (args ?? {}) as { limit?: number }
    return getWrongQuestions(db, limit)
  })

  // Phase 3 — Documents
  registerHandler(IPC.DOC_LIST, async () => listDocuments(db))

  registerHandler(IPC.DOC_IMPORT, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 PDF 文件',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return null

    const filePath = result.filePaths[0]
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath
    const title = fileName.replace(/\.pdf$/i, '')

    // Compute MD5 via Python (avoids importing crypto-heavy libs in renderer)
    const md5Res = await fetch(`http://127.0.0.1:${pythonManager.port}/pdf/md5`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ file_path: filePath }),
    })
    const { md5 } = await md5Res.json() as { md5: string }

    // Check for duplicate
    const existing = getDocumentByMd5(db, md5)
    if (existing) return { duplicate: true, document: existing }

    // Create document record
    const doc = insertDocument(db, { title, file_path: filePath, page_count: 0, md5 })

    // Create a progress task for this import
    const taskId = taskManager!.createTask('pdf_import', { docId: doc.id, filePath })
    wsClient.connect(taskId)

    // Register completion callback — store chunks when Python finishes
    wsClient.onComplete(taskId, (_, result) => {
      const { page_count, chunks } = result as { page_count: number; chunks: Array<{ doc_id: string; page_num: number; content: string; knowledge_tags: string[] }> }
      try {
        updateDocumentPageCount(db, doc.id, page_count)
        insertChunks(db, chunks)
        taskManager!.updateTask(taskId, 'completed', { chunkCount: chunks.length })
      } catch (e) {
        console.error('[DocImport] Failed to store chunks:', e)
      }
    })
    wsClient.onError(taskId, (_, error) => {
      taskManager!.updateTask(taskId, 'failed', { error })
    })

    // Kick off Python parsing (non-blocking)
    fetch(`http://127.0.0.1:${pythonManager.port}/pdf/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ file_path: filePath, doc_id: doc.id, task_id: taskId }),
    }).catch((e) => console.error('[DocImport] Python parse request failed:', e))

    return { document: doc, taskId }
  })

  registerHandler(IPC.DOC_DELETE, async (id) => deleteDocument(db, id as string))
  registerHandler(IPC.DOC_GET_CHUNKS, async (docId) => getChunks(db, docId as string))

  // Phase 3 — AI config
  registerHandler(IPC.AI_GET_CONFIG, async () => {
    // Return config without exposing encrypted key; indicate if key is set
    const cfg = { ...aiConfig }
    const hasKey = !!(cfg as Record<string, Record<string, unknown>>).openai?.encryptedApiKey
    return { ...cfg, openai: { ...(cfg as Record<string, Record<string, unknown>>).openai, apiKey: hasKey ? '••••••••' : '', encryptedApiKey: undefined } }
  })

  registerHandler(IPC.AI_SET_CONFIG, async (args) => {
    const { mode, openai, ollama } = args as {
      mode?: string
      openai?: { baseUrl?: string; apiKey?: string; model?: string }
      ollama?: { baseUrl?: string; model?: string }
    }
    if (mode) aiConfig.mode = mode
    if (openai) {
      const existing = (aiConfig as Record<string, Record<string, unknown>>).openai ?? {}
      const updated: Record<string, unknown> = {
        ...existing,
        baseUrl: openai.baseUrl ?? existing.baseUrl,
        model: openai.model ?? existing.model,
      }
      if (openai.apiKey && openai.apiKey !== '••••••••') {
        if (safeStorage.isEncryptionAvailable()) {
          updated.encryptedApiKey = safeStorage.encryptString(openai.apiKey)
        } else {
          updated.apiKey = openai.apiKey
        }
      }
      ;(aiConfig as Record<string, Record<string, unknown>>).openai = updated
    }
    if (ollama) {
      const existing = (aiConfig as Record<string, Record<string, unknown>>).ollama ?? {}
      ;(aiConfig as Record<string, Record<string, unknown>>).ollama = { ...existing, ...ollama }
    }
    saveAiConfig()
  })

  registerHandler(IPC.AI_TEST_CONNECTION, async () => {
    const cfg = buildProviderConfig()
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/ai/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ ai_config: cfg }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string }
      throw Object.assign(new Error(err.detail ?? 'Test failed'), { code: 'AI_TEST_FAILED' })
    }
    return res.json()
  })

  registerHandler(IPC.AI_GENERATE_QUESTIONS, async (args) => {
    const params = args as { count?: number; types?: string[]; knowledge_tags?: string[]; difficulty?: number; context?: string }
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/ai/generate-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ ai_config: buildProviderConfig(), ...params }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string }
      throw Object.assign(new Error(err.detail ?? 'Generation failed'), { code: 'AI_GEN_FAILED' })
    }
    return res.json()
  })

  registerHandler(IPC.AI_GRADE_ESSAY, async (args) => {
    const params = args as { question: string; reference_points?: string; user_answer: string }
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/ai/grade-essay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ ai_config: buildProviderConfig(), ...params }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string }
      throw Object.assign(new Error(err.detail ?? 'Grading failed'), { code: 'AI_GRADE_FAILED' })
    }
    return res.json()
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.softexam')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  verifySQLCipher()
  loadAiConfig()

  try {
    const db = await initDatabase()
    taskManager = new TaskManager(db)
    taskManager.recoverOrphanedTasks()
    console.log('[App] Database ready')
  } catch (e) {
    console.error('[App] Database init failed:', e)
  }

  mainWindow = createWindow()

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
