import { app, shell, BrowserWindow, dialog, safeStorage, Notification } from 'electron'
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
import {
  listCrawlerRules, upsertCrawlerRule, deleteCrawlerRule,
  createCrawlerRun, updateCrawlerRun, listCrawlerRuns, addCrawledCount
} from './db/crawler'
import {
  listEssays, createEssay, getEssay, updateEssaySection, updateEssayMeta,
  saveEssayVersion, listEssayVersions, restoreEssayVersion, deleteEssay,
  listEssayMaterials, upsertEssayMaterial, deleteEssayMaterial
} from './db/essay'
import {
  getActivePlan, createPlan, deletePlan, getPlanTasks, getTodayTasks,
  updatePlanTask, getCalendar, getPlanStats, adaptPlan,
  startSession, endSession, getTodaySessions
} from './db/plan'
import { listAchievements, checkAndUnlockAchievements } from './db/achievements'
import {
  listBackups, createBackup, deleteBackupRecord, shouldAutoBackup, pruneOldBackups,
  getDefaultBackupDir
} from './db/backup'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'fs'
import { join as pathJoin } from 'path'
import { execSync } from 'child_process'

// Ensure UTF-8 console output on Windows (prevents garbled Chinese/Unicode in logs)
if (process.platform === 'win32') {
  try { execSync('chcp 65001', { stdio: 'pipe' }) } catch { /* non-critical */ }
}

const pythonManager = new PythonManager()
const wsClient = new WsProgressClient()
let taskManager: TaskManager | null = null
let mainWindow: BrowserWindow | null = null

// AI config (persisted to userData/ai-config.json; API key via safeStorage)
let aiConfig: Record<string, unknown> = {
  mode: 'openai',
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5' },
  anthropic: { model: 'claude-sonnet-4-6' },
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
  const cfg = { ...aiConfig } as Record<string, Record<string, unknown>>
  // Decrypt OpenAI key
  const encOpenAI = cfg.openai?.encryptedApiKey as Buffer | undefined
  if (encOpenAI && safeStorage.isEncryptionAvailable()) {
    try {
      cfg.openai = { ...cfg.openai, apiKey: safeStorage.decryptString(Buffer.from(encOpenAI)) }
    } catch { /* use empty key */ }
  }
  // Decrypt Anthropic key
  const encAnthropic = cfg.anthropic?.encryptedApiKey as Buffer | undefined
  if (encAnthropic && safeStorage.isEncryptionAvailable()) {
    try {
      cfg.anthropic = { ...cfg.anthropic, apiKey: safeStorage.decryptString(Buffer.from(encAnthropic)) }
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

function checkAndNotify(): void {
  try {
    if (!Notification.isSupported()) return
    const db = getDatabase()
    const plan = getActivePlan(db)
    if (!plan?.exam_date) return

    const reminderTime = (appSettings['reminderTime'] as string) ?? '20:00'
    const [rh, rm] = reminderTime.split(':').map(Number)
    const now = new Date()
    const diffMin = Math.abs(now.getHours() * 60 + now.getMinutes() - (rh * 60 + rm))
    if (diffMin > 30) return

    const today = now.toISOString().slice(0, 10)
    if (appSettings['lastNotifyDate'] === today) return

    const todayTasks = getTodayTasks(db, plan.id)
    const pendingCount = todayTasks.filter((t) => t.status !== 'completed').length
    const examDate = new Date(plan.exam_date)
    const daysLeft = Math.max(0, Math.ceil((examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))

    appSettings['lastNotifyDate'] = today

    if (pendingCount > 0) {
      new Notification({
        title: '软考备考提醒',
        body: `距考试还有 ${daysLeft} 天，今日还有 ${pendingCount} 个任务待完成，加油！`,
      }).show()
    } else if (daysLeft <= 7) {
      new Notification({
        title: '冲刺提醒',
        body: `距考试仅剩 ${daysLeft} 天！今日任务已完成，请继续复习薄弱知识点。`,
      }).show()
    }
  } catch { /* non-critical */ }
}

// ─── Health reminder ────────────────────────────────────────────────────────
let continuousStudyStartMs: number | null = null

function updateContinuousStudy(active: boolean): void {
  if (active) {
    if (continuousStudyStartMs === null) continuousStudyStartMs = Date.now()
  } else {
    continuousStudyStartMs = null
  }
}

function checkHealthReminder(): void {
  try {
    if (!Notification.isSupported()) return
    if (appSettings['healthEnabled'] === false) return
    if (continuousStudyStartMs === null) return

    const thresholdMin = (appSettings['healthReminderMin'] as number) ?? 45
    const elapsed = Date.now() - continuousStudyStartMs
    if (elapsed < thresholdMin * 60 * 1000) return

    // Reset so we don't spam
    continuousStudyStartMs = Date.now()

    new Notification({
      title: '健康学习提醒',
      body: `您已连续学习 ${thresholdMin} 分钟，请起身活动一下，保护眼睛和颈椎！`,
    }).show()
  } catch { /* non-critical */ }
}

function setupNotificationTimer(): void {
  // Check shortly after startup, then every hour
  setTimeout(() => checkAndNotify(), 15_000)
  setInterval(() => checkAndNotify(), 60 * 60 * 1000)
  // Health reminder: check every 5 minutes
  setInterval(() => checkHealthReminder(), 5 * 60 * 1000)
}

function registerIpcHandlers(): void {
  const db = getDatabase()

  // Phase 0
  registerHandler(IPC.PING, async () => pythonManager.ping())
  registerHandler(IPC.GET_PYTHON_STATUS, async () => ({ ready: pythonManager.isReady }))

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
    const cfg = { ...aiConfig } as Record<string, Record<string, unknown>>
    const hasOpenAIKey = !!cfg.openai?.encryptedApiKey
    const hasAnthropicKey = !!cfg.anthropic?.encryptedApiKey
    return {
      ...cfg,
      openai: { ...cfg.openai, apiKey: hasOpenAIKey ? '••••••••' : '', encryptedApiKey: undefined },
      anthropic: { ...cfg.anthropic, apiKey: hasAnthropicKey ? '••••••••' : '', encryptedApiKey: undefined },
    }
  })

  registerHandler(IPC.AI_SET_CONFIG, async (args) => {
    const { mode, openai, ollama, anthropic } = args as {
      mode?: string
      openai?: { baseUrl?: string; apiKey?: string; model?: string }
      ollama?: { baseUrl?: string; model?: string }
      anthropic?: { apiKey?: string; model?: string }
    }
    const cfgTyped = aiConfig as Record<string, Record<string, unknown>>
    if (mode) aiConfig.mode = mode
    if (openai) {
      const existing = cfgTyped.openai ?? {}
      const updated: Record<string, unknown> = {
        ...existing,
        baseUrl: openai.baseUrl ?? existing.baseUrl,
        model: openai.model ?? existing.model,
      }
      if (openai.apiKey && openai.apiKey !== '••••••••') {
        if (safeStorage.isEncryptionAvailable()) {
          updated.encryptedApiKey = safeStorage.encryptString(openai.apiKey)
          delete updated.apiKey
        } else {
          updated.apiKey = openai.apiKey
        }
      }
      cfgTyped.openai = updated
    }
    if (ollama) {
      cfgTyped.ollama = { ...(cfgTyped.ollama ?? {}), ...ollama }
    }
    if (anthropic) {
      const existing = cfgTyped.anthropic ?? {}
      const updated: Record<string, unknown> = {
        ...existing,
        model: anthropic.model ?? existing.model,
      }
      if (anthropic.apiKey && anthropic.apiKey !== '••••••••') {
        if (safeStorage.isEncryptionAvailable()) {
          updated.encryptedApiKey = safeStorage.encryptString(anthropic.apiKey)
          delete updated.apiKey
        } else {
          updated.apiKey = anthropic.apiKey
        }
      }
      cfgTyped.anthropic = updated
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

  // Phase 5 — Crawler
  registerHandler(IPC.CRAWLER_LIST_RULES, async () => listCrawlerRules(db))

  registerHandler(IPC.CRAWLER_UPSERT_RULE, async (args) =>
    upsertCrawlerRule(db, args as Parameters<typeof upsertCrawlerRule>[1]))

  registerHandler(IPC.CRAWLER_DELETE_RULE, async (id) => deleteCrawlerRule(db, id as string))

  registerHandler(IPC.CRAWLER_LIST_RUNS, async (ruleId) => listCrawlerRuns(db, ruleId as string))

  registerHandler(IPC.CRAWLER_TEST, async (args) => {
    const { rule, test_url } = args as { rule: unknown; test_url: string }
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/crawler/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ rule, test_url }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string }
      throw Object.assign(new Error(err.detail ?? 'Test failed'), { code: 'CRAWLER_TEST_FAILED' })
    }
    return res.json()
  })

  registerHandler(IPC.CRAWLER_RUN, async (args) => {
    const { ruleId } = args as { ruleId: string }
    const rules = listCrawlerRules(db)
    const rule = rules.find((r) => r.id === ruleId)
    if (!rule) throw Object.assign(new Error('Rule not found'), { code: 'NOT_FOUND' })

    const run = createCrawlerRun(db, ruleId)
    const taskId = taskManager!.createTask('crawl', { ruleId, runId: run.id })
    wsClient.connect(taskId)

    wsClient.onComplete(taskId, (_, result) => {
      const { questions, total_found } = result as { questions: unknown[]; total_found: number; rule_id: string }
      try {
        const saved = batchInsertQuestions(db, questions.map((q) => ({ ...(q as object), source_type: 'crawled' })) as Parameters<typeof batchInsertQuestions>[1])
        updateCrawlerRun(db, run.id, {
          status: 'completed',
          total_found,
          total_saved: saved,
          ended_at: new Date().toISOString(),
        })
        addCrawledCount(db, ruleId, saved)
        taskManager!.updateTask(taskId, 'completed', { saved })
      } catch (e) {
        console.error('[Crawler] Failed to save questions:', e)
      }
    })
    wsClient.onError(taskId, (_, error) => {
      updateCrawlerRun(db, run.id, { status: 'failed', ended_at: new Date().toISOString(), error_msg: String(error) })
      taskManager!.updateTask(taskId, 'failed', { error })
    })

    fetch(`http://127.0.0.1:${pythonManager.port}/crawler/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ rule, task_id: taskId, rule_id: ruleId }),
    }).catch((e) => console.error('[Crawler] Run request failed:', e))

    return { taskId, runId: run.id }
  })

  // Phase 5 — Knowledge Graph (computed in main process from SQLite)
  registerHandler(IPC.GRAPH_BUILD, async () => {
    const chunks = db.prepare("SELECT knowledge_tags FROM doc_chunks WHERE knowledge_tags != '[]'").all() as { knowledge_tags: string }[]
    const questions = db.prepare("SELECT knowledge_tags FROM questions WHERE knowledge_tags != '[]'").all() as { knowledge_tags: string }[]

    const qCounts: Record<string, number> = {}
    const dCounts: Record<string, number> = {}
    const coOcc: Record<string, number> = {}

    for (const q of questions) {
      const tags: string[] = JSON.parse(q.knowledge_tags ?? '[]')
      for (const t of tags) qCounts[t] = (qCounts[t] ?? 0) + 1
    }
    for (const c of chunks) {
      const tags: string[] = JSON.parse(c.knowledge_tags ?? '[]')
      for (const t of tags) dCounts[t] = (dCounts[t] ?? 0) + 1
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const key = [tags[i], tags[j]].sort().join('|||')
          coOcc[key] = (coOcc[key] ?? 0) + 1
        }
      }
    }

    const allTags = new Set([...Object.keys(qCounts), ...Object.keys(dCounts)])
    const nodes = Array.from(allTags).map((tag) => ({
      id: tag,
      name: tag,
      questionCount: qCounts[tag] ?? 0,
      docCount: dCounts[tag] ?? 0,
      value: (qCounts[tag] ?? 0) + (dCounts[tag] ?? 0),
    }))
    const edges = Object.entries(coOcc).map(([key, value]) => {
      const [source, target] = key.split('|||')
      return { source, target, value }
    })
    return { nodes, edges }
  })

  // Phase 5 — Essay
  registerHandler(IPC.ESSAY_LIST, async () => listEssays(db))
  registerHandler(IPC.ESSAY_CREATE, async (args) => {
    const { title } = (args ?? {}) as { title?: string }
    return createEssay(db, title)
  })
  registerHandler(IPC.ESSAY_GET, async (id) => getEssay(db, id as string))
  registerHandler(IPC.ESSAY_UPDATE_SECTION, async (args) => {
    const { essayId, sectionKey, content } = args as { essayId: string; sectionKey: string; content: string }
    return updateEssaySection(db, essayId, sectionKey, content)
  })
  registerHandler(IPC.ESSAY_UPDATE_META, async (args) => {
    const { id, ...patch } = args as { id: string; title?: string; question?: string }
    updateEssayMeta(db, id, patch)
  })
  registerHandler(IPC.ESSAY_SAVE_VERSION, async (essayId) => saveEssayVersion(db, essayId as string))
  registerHandler(IPC.ESSAY_LIST_VERSIONS, async (essayId) => listEssayVersions(db, essayId as string))
  registerHandler(IPC.ESSAY_RESTORE_VERSION, async (args) => {
    const { essayId, versionId } = args as { essayId: string; versionId: string }
    restoreEssayVersion(db, essayId, versionId)
  })
  registerHandler(IPC.ESSAY_DELETE, async (id) => deleteEssay(db, id as string))
  registerHandler(IPC.ESSAY_LIST_MATERIALS, async () => listEssayMaterials(db))
  registerHandler(IPC.ESSAY_UPSERT_MATERIAL, async (args) =>
    upsertEssayMaterial(db, args as Parameters<typeof upsertEssayMaterial>[1]))
  registerHandler(IPC.ESSAY_DELETE_MATERIAL, async (id) => deleteEssayMaterial(db, id as string))

  registerHandler(IPC.ESSAY_AI_SUGGEST, async (args) => {
    const params = args as { section_key: string; section_label: string; current_content: string; word_target: number }
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/ai/essay-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ ai_config: buildProviderConfig(), ...params }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string }
      throw Object.assign(new Error(err.detail ?? 'Suggest failed'), { code: 'AI_SUGGEST_FAILED' })
    }
    return res.json()
  })

  // Phase 5 — AI Chat with RAG (FTS5 doc context)
  registerHandler(IPC.AI_CHAT, async (args) => {
    const { question, useDocContext = true } = args as { question: string; useDocContext?: boolean }
    let docChunks: unknown[] = []

    if (useDocContext) {
      try {
        const ftsQ = question.replace(/["']/g, ' ')
        docChunks = db.prepare(`
          SELECT dc.content, dc.page_num, d.title as doc_title
          FROM doc_chunks dc
          JOIN documents d ON d.id = dc.doc_id
          JOIN doc_chunks_fts f ON dc.id = f.rowid
          WHERE doc_chunks_fts MATCH ?
          LIMIT 5
        `).all(ftsQ) as unknown[]
      } catch {
        // FTS not available or no results
      }
    }

    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ ai_config: buildProviderConfig(), question, doc_chunks: docChunks }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string }
      throw Object.assign(new Error(err.detail ?? 'Chat failed'), { code: 'AI_CHAT_FAILED' })
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

  // Phase 4 — Study Plans
  registerHandler(IPC.PLAN_GET_ACTIVE, async () => getActivePlan(db))
  registerHandler(IPC.PLAN_CREATE, async (args) => {
    const { examDate, mode, config } = args as { examDate: string; mode: 'normal' | 'sprint'; config?: Record<string, unknown> }
    return createPlan(db, examDate, mode, config)
  })
  registerHandler(IPC.PLAN_DELETE, async (id) => deletePlan(db, id as string))
  registerHandler(IPC.PLAN_GET_TASKS, async (args) => {
    const { planId, dateFrom, dateTo } = args as { planId: string; dateFrom?: string; dateTo?: string }
    return getPlanTasks(db, planId, dateFrom, dateTo)
  })
  registerHandler(IPC.PLAN_UPDATE_TASK, async (args) => {
    const { taskId, changes } = args as { taskId: string; changes: { status?: string; actual_count?: number } }
    updatePlanTask(db, taskId, changes)
  })
  registerHandler(IPC.PLAN_GET_STATS, async (planId) => getPlanStats(db, planId as string))
  registerHandler(IPC.PLAN_GET_CALENDAR, async (args) => {
    const { planId, year, month } = args as { planId: string; year: number; month: number }
    return getCalendar(db, planId, year, month)
  })
  registerHandler(IPC.PLAN_ADAPT, async (planId) => adaptPlan(db, planId as string))

  // Phase 4 — Study Sessions
  registerHandler(IPC.SESSION_START, async (args) => {
    const { type, planTaskId } = (args ?? {}) as { type?: 'manual' | 'pomodoro'; planTaskId?: string }
    updateContinuousStudy(true)
    return startSession(db, type ?? 'manual', planTaskId)
  })
  registerHandler(IPC.SESSION_END, async (args) => {
    const { id, durationMs } = args as { id: string; durationMs: number }
    endSession(db, id, durationMs)
    updateContinuousStudy(false)
  })
  registerHandler(IPC.SESSION_GET_TODAY, async () => getTodaySessions(db))

  // Phase 6 — Achievements
  registerHandler(IPC.ACHIEVEMENT_LIST, async () => listAchievements(db))
  registerHandler(IPC.ACHIEVEMENT_CHECK, async () => {
    const newly = checkAndUnlockAchievements(db)
    if (newly.length > 0 && Notification.isSupported()) {
      for (const a of newly) {
        new Notification({
          title: `成就解锁：${a.title}`,
          body: a.desc,
        }).show()
      }
      mainWindow?.webContents.send('achievement:unlocked', newly)
    }
    return newly
  })

  // Phase 6 — Backup & Restore
  registerHandler(IPC.BACKUP_LIST, async () => listBackups(db))

  registerHandler(IPC.BACKUP_CREATE, async (args) => {
    const { note } = (args ?? {}) as { note?: string }
    let destDir: string
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择备份保存目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) {
      destDir = getDefaultBackupDir()
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    } else {
      destDir = result.filePaths[0]
    }
    const rec = await createBackup(db, destDir, note ?? '')
    pruneOldBackups(db)
    return rec
  })

  registerHandler(IPC.BACKUP_RESTORE, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择备份文件',
      filters: [{ name: 'SQLite DB', extensions: ['db'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return { restored: false }

    const backupPath = result.filePaths[0]
    const dbPath = pathJoin(app.getPath('userData'), 'softexam.db')

    // Close DB, copy backup over current DB, reopen
    closeDatabase()
    try {
      copyFileSync(backupPath, dbPath)
    } catch (e) {
      // Reopen with whatever exists
      await initDatabase()
      throw Object.assign(new Error('恢复失败：' + String(e)), { code: 'RESTORE_FAILED' })
    }
    await initDatabase()
    return { restored: true }
  })

  registerHandler(IPC.BACKUP_DELETE, async (id) => {
    const recs = listBackups(db)
    const rec = recs.find((r) => r.id === id)
    if (rec && existsSync(rec.file_path)) {
      try { unlinkSync(rec.file_path) } catch { /* non-critical */ }
    }
    deleteBackupRecord(db, id as string)
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
    registerIpcHandlers()

    // Auto-backup: if no backup in last 24h, create one silently
    setTimeout(async () => {
      try {
        if (shouldAutoBackup(db)) {
          const defaultDir = getDefaultBackupDir()
          if (!existsSync(defaultDir)) mkdirSync(defaultDir, { recursive: true })
          await createBackup(db, defaultDir, 'auto')
          pruneOldBackups(db)
          console.log('[Backup] Auto-backup completed')
        }
      } catch (e) {
        console.warn('[Backup] Auto-backup failed:', e)
      }
    }, 30_000)
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

  setupNotificationTimer()

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
