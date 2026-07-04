import { app, shell, BrowserWindow, dialog, safeStorage, Notification } from 'electron'
import { spawn } from 'child_process'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Database from 'better-sqlite3-multiple-ciphers'
import icon from '../../resources/icon.png?asset'
import { PythonManager } from './python-manager'
import { IPC } from './ipc-channels'
import { verifySQLCipher } from './db/verify'
import { initDatabase, getDatabase, closeDatabase, getOrCreateDatabaseKey } from './db/index'
import { TaskManager } from './task-manager'
import { WsProgressClient } from './ws-client'
import { registerHandler } from './ipc-handler'
import {
  queryQuestions, searchQuestions, insertQuestion, batchInsertQuestions,
  updateQuestion, deleteQuestion, toggleFavorite, getQuestionStats, getWrongQuestions
} from './db/questions'
import {
  listQuestionGroups, upsertQuestionGroup, deleteQuestionGroup, getQuestionGroup,
  type QuestionGroupInput, type QuestionGroupType,
} from './db/question-groups'
import { startPractice, submitAnswer, endPractice } from './db/practice'
import {
  listDocuments, getDocumentByMd5, insertDocument, updateDocumentPageCount,
  deleteDocument, getDocumentById, insertChunks, deleteDocChunks, getDocChunkCount,
  getChunks, remapManagedDocumentPaths
} from './db/documents'
import {
  listCrawlerRules, upsertCrawlerRule, deleteCrawlerRule,
  createCrawlerRun, updateCrawlerRun, listCrawlerRuns, addCrawledCount,
  saveCrawlerReviewItems, listCrawlerReviewItems, updateCrawlerReviewStatus,
  getCrawlerReviewItemsByIds,
  upsertCrawlerSiteSession, listCrawlerSiteSessions, getCrawlerSiteSession,
  touchCrawlerSiteSessionValidation, deleteCrawlerSiteSession,
  type NormalizedCrawlerPayload,
  type CrawlerRule,
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
  createAiChatSession,
  deleteAiChatSession,
  getLatestAiChatSession,
  insertAiChatMessage,
  listAiChatMessages,
  listAiChatSessions,
  getAiChatSession,
} from './db/ai-chat'
import {
  listBackups, createBackup, deleteBackupRecord, shouldAutoBackup, pruneOldBackups,
  getDefaultBackupDir, remapManagedBackupPaths
} from './db/backup'
import {
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import {
  ensureStorageDirectories,
  getStoragePathConfig,
  getStoragePaths,
  loadStoragePathConfig,
  migrateLegacyUserDataIfNeeded,
  resolveStoragePaths,
  saveStoragePathConfig,
  type StoragePathConfig,
} from './storage-paths'

const pythonManager = new PythonManager()
const wsClient = new WsProgressClient()
let taskManager: TaskManager | null = null
let mainWindow: BrowserWindow | null = null
let resourcesCleanedUp = false

// AI config (persisted under the configured data root; API key via safeStorage)
let aiConfig: Record<string, unknown> = {
  mode: 'openai',
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5' },
  anthropic: { model: 'claude-sonnet-4-6' },
}
const MASKED_SECRET = '__MASKED__'

type ProviderConfigOverride = {
  mode?: string
  openai?: { baseUrl?: string; apiKey?: string; model?: string }
  ollama?: { baseUrl?: string; model?: string }
  anthropic?: { apiKey?: string; model?: string }
}

function loadAiConfig(): void {
  const p = getStoragePaths().aiConfigPath
  if (!existsSync(p)) return
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw)
    aiConfig = { ...aiConfig, ...parsed }
  } catch { /* use defaults */ }
}

function saveAiConfig(): void {
  try {
    ensureStorageDirectories()
    writeFileSync(getStoragePaths().aiConfigPath, JSON.stringify(aiConfig, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

function buildProviderConfig(override?: ProviderConfigOverride): Record<string, unknown> {
  const source = aiConfig as Record<string, Record<string, unknown>>
  const cfg = {
    ...source,
    openai: { ...(source.openai ?? {}) },
    ollama: { ...(source.ollama ?? {}) },
    anthropic: { ...(source.anthropic ?? {}) },
  } as Record<string, unknown> & {
    mode?: string
    openai: Record<string, unknown>
    ollama: Record<string, unknown>
    anthropic: Record<string, unknown>
  }
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

  if (!override) return cfg

  if (override.mode) cfg.mode = override.mode
  if (override.openai) {
    cfg.openai = {
      ...(cfg.openai ?? {}),
      baseUrl: override.openai.baseUrl ?? cfg.openai?.baseUrl,
      model: override.openai.model ?? cfg.openai?.model,
    }
    if (override.openai.apiKey !== undefined && override.openai.apiKey !== MASKED_SECRET) {
      cfg.openai.apiKey = override.openai.apiKey
    }
  }
  if (override.ollama) {
    cfg.ollama = {
      ...(cfg.ollama ?? {}),
      baseUrl: override.ollama.baseUrl ?? cfg.ollama?.baseUrl,
      model: override.ollama.model ?? cfg.ollama?.model,
    }
  }
  if (override.anthropic) {
    cfg.anthropic = {
      ...(cfg.anthropic ?? {}),
      model: override.anthropic.model ?? cfg.anthropic?.model,
    }
    if (override.anthropic.apiKey !== undefined && override.anthropic.apiKey !== MASKED_SECRET) {
      cfg.anthropic.apiKey = override.anthropic.apiKey
    }
  }
  return cfg
}

const appSettings: Record<string, unknown> = {}

function loadAppSettings(): void {
  const p = getStoragePaths().appSettingsPath
  if (!existsSync(p)) return
  try {
    Object.assign(appSettings, JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>)
  } catch { /* use defaults */ }
}

function saveAppSettings(): void {
  try {
    ensureStorageDirectories()
    writeFileSync(getStoragePaths().appSettingsPath, JSON.stringify(appSettings, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

function normalizeOptionalDir(input?: string): string | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return resolve(trimmed)
}

function sanitizeFileName(input: string): string {
  const sanitized = input.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return sanitized || 'document'
}

function isPathInsideDirectory(filePath: string, dirPath: string): boolean {
  const rel = relative(resolve(dirPath), resolve(filePath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function copyDirectoryIfNeeded(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) return
  if (normalize(resolve(sourceDir)) === normalize(resolve(targetDir))) return
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir)) {
    cpSync(join(sourceDir, entry), join(targetDir, entry), { recursive: true, force: false, errorOnExist: false })
  }
}

function copyFileIfNeeded(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) return
  if (normalize(resolve(sourcePath)) === normalize(resolve(targetPath))) return
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(sourcePath, targetPath)
}

function copyDatabaseFiles(sourceDbPath: string, targetDbPath: string): void {
  if (!existsSync(sourceDbPath)) return
  if (normalize(resolve(sourceDbPath)) === normalize(resolve(targetDbPath))) return
  mkdirSync(dirname(targetDbPath), { recursive: true })
  copyFileSync(sourceDbPath, targetDbPath)
  for (const suffix of ['-wal', '-shm']) {
    const sourceExtra = `${sourceDbPath}${suffix}`
    const targetExtra = `${targetDbPath}${suffix}`
    if (existsSync(sourceExtra)) copyFileSync(sourceExtra, targetExtra)
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function isPlainSqliteFile(filePath: string): boolean {
  try {
    const header = readFileSync(filePath).subarray(0, 16).toString('ascii')
    return header === 'SQLite format 3\u0000'
  } catch {
    return false
  }
}

function buildManagedDocumentPath(sourcePath: string, md5: string, paths = getStoragePaths()): string {
  const extension = extname(sourcePath) || '.pdf'
  const baseName = sanitizeFileName(basename(sourcePath, extension))
  return join(paths.documentLibraryDir, `${baseName}-${md5.slice(0, 8)}${extension}`)
}

function getStorageSettingsPayload(paths = getStoragePaths()) {
  const config = getStoragePathConfig()
  return {
    bootstrapConfigPath: paths.bootstrapConfigPath,
    dataRootDir: paths.dataRootDir,
    defaultDataRootDir: paths.defaultDataRootDir,
    aiConfigPath: paths.aiConfigPath,
    appSettingsPath: paths.appSettingsPath,
    databasePath: paths.databasePath,
    documentLibraryDir: paths.documentLibraryDir,
    backupDir: paths.backupDir,
    customDataRootDir: config.dataRootDir ?? '',
    usingCustomDataRoot: Boolean(config.dataRootDir),
  }
}

async function updateStoragePaths(args: {
  dataRootDir?: string
}): Promise<{ paths: ReturnType<typeof getStorageSettingsPayload>; restartRequired: boolean }> {
  const currentPaths = getStoragePaths()
  const nextConfig: StoragePathConfig = {
    dataRootDir: normalizeOptionalDir(args.dataRootDir),
  }
  const nextPaths = resolveStoragePaths(nextConfig)

  ensureStorageDirectories(nextPaths)

  const db = getDatabase()
  db.pragma('wal_checkpoint(FULL)')

  if (currentPaths.documentLibraryDir !== nextPaths.documentLibraryDir) {
    remapManagedDocumentPaths(db, currentPaths.documentLibraryDir, nextPaths.documentLibraryDir)
    copyDirectoryIfNeeded(currentPaths.documentLibraryDir, nextPaths.documentLibraryDir)
  }
  if (currentPaths.backupDir !== nextPaths.backupDir) {
    remapManagedBackupPaths(db, currentPaths.backupDir, nextPaths.backupDir)
    copyDirectoryIfNeeded(currentPaths.backupDir, nextPaths.backupDir)
  }

  writeJsonFile(nextPaths.aiConfigPath, aiConfig)
  writeJsonFile(nextPaths.appSettingsPath, appSettings)
  copyDatabaseFiles(currentPaths.databasePath, nextPaths.databasePath)
  copyFileIfNeeded(currentPaths.databaseKeyPath, nextPaths.databaseKeyPath)

  saveStoragePathConfig(nextConfig)

  return {
    paths: getStorageSettingsPayload(nextPaths),
    restartRequired: currentPaths.databasePath !== nextPaths.databasePath
      || currentPaths.documentLibraryDir !== nextPaths.documentLibraryDir,
  }
}

function relaunchApplication(): void {
  if (is.dev) {
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env },
      stdio: 'ignore',
    })
    child.unref()
    app.exit(0)
    return
  }

  app.relaunch()
  app.exit(0)
}

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

function cleanupAppResources(): void {
  if (resourcesCleanedUp) return
  resourcesCleanedUp = true
  wsClient.disconnectAll()
  pythonManager.stop()
  closeDatabase()
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
    saveAppSettings()

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

// Health reminder
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

function resolveQuestionGroupId(
  db: Database.Database,
  args: { target_group_id?: string | null; new_group?: QuestionGroupInput | null },
  fallbackType: QuestionGroupType
): string | null {
  if (args.target_group_id) {
    const existing = getQuestionGroup(db, args.target_group_id)
    if (!existing) {
      throw Object.assign(new Error('Question group not found'), { code: 'QUESTION_GROUP_NOT_FOUND' })
    }
    return existing.id
  }

  if (args.new_group?.name?.trim()) {
    const created = upsertQuestionGroup(db, {
      ...args.new_group,
      group_type: args.new_group.group_type ?? fallbackType,
    })
    return created.id
  }

  return null
}

function getCrawlerSiteId(rule: Pick<CrawlerRule, 'id'>): string {
  return rule.id
}

function encryptCrawlerState(state: unknown): Buffer {
  const raw = JSON.stringify(state)
  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(raw, 'utf-8')
  }
  return safeStorage.encryptString(raw)
}

function decryptCrawlerState(encrypted: Buffer): unknown {
  if (!safeStorage.isEncryptionAvailable()) {
    return JSON.parse(Buffer.from(encrypted).toString('utf-8'))
  }
  return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted)))
}

async function collectCrawlerWebState(win: BrowserWindow): Promise<{
  cookies: Electron.Cookie[]
  localStorage: Record<string, string>
  origin: string
  url: string
}> {
  const cookies = await win.webContents.session.cookies.get({})
  const url = win.webContents.getURL()
  let origin = ''
  try {
    origin = new URL(url).origin
  } catch {
    origin = ''
  }
  const localStorage = await win.webContents.executeJavaScript(`
    (() => {
      const data = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key) data[key] = localStorage.getItem(key);
      }
      return data;
    })()
  `, true) as Record<string, string>
  return { cookies, localStorage, origin, url }
}

function resolveCrawlerLoginUrl(rule: CrawlerRule): string {
  const ruleJson = parseCrawlerRuleJson(rule)
  const authCfg = getNestedRecord(ruleJson, ['auth'])
  const loginCfg = getNestedRecord(ruleJson, ['auth', 'login'])
  const successCfg = getNestedRecord(ruleJson, ['auth', 'success'])
  return firstString(
    rule.login_url,
    authCfg.login_url,
    loginCfg.url,
    loginCfg.login_url,
    successCfg.login_url,
  )
}

async function openCrawlerAuthWindow(args: {
  rule: CrawlerRule
  accountAlias: string
}): Promise<ReturnType<typeof upsertCrawlerSiteSession>> {
  const loginUrl = resolveCrawlerLoginUrl(args.rule)
  if (!loginUrl) {
    throw Object.assign(new Error('Login URL is required. Set 登录 URL or rule_json.auth.login_url.'), { code: 'CRAWLER_LOGIN_URL_REQUIRED' })
  }

  const authWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    title: `Authorize ${args.rule.site_name}`,
    parent: mainWindow ?? undefined,
    modal: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: false,
      partition: `crawler-auth-${args.rule.id}-${Date.now()}`,
    },
  })

  const finishPromise = new Promise<ReturnType<typeof upsertCrawlerSiteSession>>((resolvePromise, rejectPromise) => {
    let settled = false
    let autoCaptureRunning = false
    let timeout: NodeJS.Timeout | null = null
    let interval: NodeJS.Timeout | null = null
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (interval) clearInterval(interval)
      fn()
      if (!authWindow.isDestroyed()) authWindow.close()
    }

    const captureAndSave = async (
      captureMode: 'auto' | 'manual',
      matchedChecks: CrawlerSessionValidationCheck[] = [],
    ) => {
      const state = await collectCrawlerWebState(authWindow)
      return upsertCrawlerSiteSession(getDatabase(), {
        site_id: getCrawlerSiteId(args.rule),
        site_name: args.rule.site_name,
        account_alias: args.accountAlias,
        encrypted_state: encryptCrawlerState(state),
        storage_meta: {
          cookie_count: state.cookies.length,
          local_storage_keys: Object.keys(state.localStorage).length,
          captured_origin: state.origin,
          captured_url: state.url,
          capture_mode: captureMode,
          matched_checks: matchedChecks.filter((check) => check.valid).map((check) => check.name),
          account_alias: args.accountAlias,
        },
      })
    }

    const tryAutoCapture = async () => {
      if (settled || autoCaptureRunning || authWindow.isDestroyed()) return
      autoCaptureRunning = true
      try {
        const detection = await detectCrawlerAuthSuccess(authWindow, args.rule)
        if (!detection.success) return
        await setCrawlerAuthWindowStatus(authWindow, 'Login detected. Capturing session...')
        await new Promise((resolveDelay) => setTimeout(resolveDelay, detection.captureDelayMs))
        if (settled || authWindow.isDestroyed()) return
        const saved = await captureAndSave('auto', detection.checks)
        settle(() => resolvePromise(saved))
      } catch {
        // Keep the window open so the user can finish manually.
      } finally {
        autoCaptureRunning = false
      }
    }

    authWindow.once('ready-to-show', () => authWindow.show())
    authWindow.on('closed', () => {
      if (!settled) {
        settled = true
        if (timeout) clearTimeout(timeout)
        if (interval) clearInterval(interval)
        rejectPromise(Object.assign(new Error('Authorization window closed'), { code: 'CRAWLER_AUTH_CANCELLED' }))
      }
    })
    authWindow.webContents.setWindowOpenHandler((details) => {
      authWindow.loadURL(details.url)
      return { action: 'deny' }
    })
    authWindow.webContents.on('did-finish-load', async () => {
      try {
        await authWindow.webContents.insertCSS(`
          #crawler-auth-finish {
            position: fixed;
            right: 18px;
            bottom: 18px;
            z-index: 2147483647;
            border: 0;
            border-radius: 6px;
            background: #1d4ed8;
            color: #fff;
            padding: 10px 14px;
            font: 600 14px system-ui, sans-serif;
            box-shadow: 0 10px 30px rgba(15, 23, 42, .28);
            cursor: pointer;
          }
          #crawler-auth-status {
            position: fixed;
            right: 18px;
            bottom: 66px;
            z-index: 2147483647;
            max-width: min(360px, calc(100vw - 36px));
            border-radius: 6px;
            background: rgba(15, 23, 42, .9);
            color: #fff;
            padding: 9px 12px;
            font: 500 13px system-ui, sans-serif;
            box-shadow: 0 10px 30px rgba(15, 23, 42, .22);
          }
        `)
        await authWindow.webContents.executeJavaScript(`
          (() => {
            if (!document.getElementById('crawler-auth-status')) {
              const status = document.createElement('div');
              status.id = 'crawler-auth-status';
              status.textContent = 'Waiting for login success...';
              document.body.appendChild(status);
            }
            if (document.getElementById('crawler-auth-finish')) return;
            const btn = document.createElement('button');
            btn.id = 'crawler-auth-finish';
            btn.textContent = '完成授权';
            btn.addEventListener('click', () => {
              window.location.href = 'crawler-auth://finish';
            });
            document.body.appendChild(btn);
          })()
        `, true)
      } catch {
        // Page CSP may block injection; the menu fallback still works via close rejection.
      }
      setTimeout(() => void tryAutoCapture(), 250)
    })
    authWindow.webContents.on('will-navigate', async (event, url) => {
      if (url !== 'crawler-auth://finish') return
      event.preventDefault()
      try {
        const saved = await captureAndSave('manual')
        settle(() => resolvePromise(saved))
      } catch (e) {
        settle(() => rejectPromise(e))
      }
    })
    authWindow.webContents.on('did-navigate', () => {
      setTimeout(() => void tryAutoCapture(), 250)
    })
    authWindow.webContents.on('did-navigate-in-page', () => {
      setTimeout(() => void tryAutoCapture(), 250)
    })
    timeout = setTimeout(() => {
      if (!settled) {
        void setCrawlerAuthWindowStatus(authWindow, 'Login success was not detected. You can complete authorization manually.')
      }
    }, 120_000)
    interval = setInterval(() => void tryAutoCapture(), 1_500)
  })

  await authWindow.loadURL(loginUrl)
  return finishPromise
}

function getDecryptedCrawlerSessionPayload(
  db: Database.Database,
  rule: CrawlerRule,
  accountAlias?: string | null,
): unknown | null {
  if (!accountAlias) return null
  const session = getCrawlerSiteSession(db, getCrawlerSiteId(rule), accountAlias)
  if (!session) return null
  return decryptCrawlerState(session.encrypted_state)
}

type CrawlerSessionValidationCheck = {
  name: string
  valid: boolean
  message: string
}

type CrawlerSessionValidationResult = {
  valid: boolean
  status?: number
  message?: string
  checks?: CrawlerSessionValidationCheck[]
}

type CrawlerAuthCheckConfig = Record<string, unknown>

type CrawlerAuthDetectionResult = {
  success: boolean
  checks: CrawlerSessionValidationCheck[]
  captureDelayMs: number
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

function matchCrawlerPattern(value: string, pattern: string): boolean {
  if (!pattern) return false
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return value.includes(pattern)
  }
}

function parseCrawlerRuleJson(rule: CrawlerRule): Record<string, unknown> {
  if (!rule.rule_json) return {}
  try {
    const parsed = JSON.parse(rule.rule_json) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function getNestedRecord(source: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current: unknown = source
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return {}
    current = (current as Record<string, unknown>)[key]
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {}
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' && value.trim() ? [value] : []
}

function toNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((item): item is number => typeof item === 'number')
  return typeof value === 'number' ? [value] : []
}

function getCrawlerAuthCheckConfig(rule: CrawlerRule, preferred: 'success' | 'validate'): CrawlerAuthCheckConfig {
  const ruleJson = parseCrawlerRuleJson(rule)
  const successCfg = getNestedRecord(ruleJson, ['auth', 'success'])
  const validateCfg = getNestedRecord(ruleJson, ['auth', 'validate'])
  const primary = preferred === 'success' ? successCfg : validateCfg
  const secondary = preferred === 'success' ? validateCfg : successCfg
  return {
    ...secondary,
    ...primary,
    validate_url: firstString(primary.validate_url, primary.url, secondary.validate_url, secondary.url, rule.validate_url),
  }
}

function cookieHeaderFromCookies(cookies: Array<{ name?: string; value?: string }>): string {
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

async function checkCrawlerValidateUrl(
  cfg: CrawlerAuthCheckConfig,
  cookies: Array<{ name?: string; value?: string }>,
): Promise<{ body: string; check?: CrawlerSessionValidationCheck }> {
  const validateUrl = firstString(cfg.validate_url, cfg.url)
  if (!validateUrl) return { body: '' }

  const method = typeof cfg.method === 'string' ? cfg.method.toUpperCase() : 'GET'
  const cookieHeader = cookieHeaderFromCookies(cookies)
  const res = await fetch(validateUrl, {
    method,
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  })
  const body = await res.text()
  const successStatuses = toNumberArray(cfg.success_statuses)
  const statusOk = successStatuses.length ? successStatuses.includes(res.status) : res.ok
  return {
    body,
    check: {
      name: 'validate_url',
      valid: statusOk,
      message: `HTTP ${res.status} ${res.statusText}`,
    },
  }
}

async function detectCrawlerAuthSuccess(
  win: BrowserWindow,
  rule: CrawlerRule,
): Promise<CrawlerAuthDetectionResult> {
  const cfg = getCrawlerAuthCheckConfig(rule, 'success')
  const checks: CrawlerSessionValidationCheck[] = []
  const url = win.webContents.getURL()
  const cookies = await win.webContents.session.cookies.get({})
  let strongSuccessMatched = false

  const requiredCookies = toStringArray(cfg.required_cookies)
  if (requiredCookies.length) {
    const cookieNames = new Set(cookies.map((cookie) => cookie.name))
    const missing = requiredCookies.filter((name) => !cookieNames.has(name))
    const valid = missing.length === 0
    checks.push({
      name: 'required_cookies',
      valid,
      message: valid ? 'Required cookies are present' : `Missing cookies: ${missing.join(', ')}`,
    })
  }

  const urlPattern = firstString(cfg.url_pattern)
  if (urlPattern) {
    const valid = matchCrawlerPattern(url, urlPattern)
    if (valid) strongSuccessMatched = true
    checks.push({
      name: 'url_pattern',
      valid,
      message: valid ? 'Current URL matched' : `Current URL did not match ${urlPattern}`,
    })
  }

  const successSelector = firstString(cfg.success_selector)
  if (successSelector) {
    let valid = false
    try {
      valid = await win.webContents.executeJavaScript(
        `Boolean(document.querySelector(${JSON.stringify(successSelector)}))`,
        true,
      ) as boolean
    } catch {
      valid = false
    }
    if (valid) strongSuccessMatched = true
    checks.push({
      name: 'success_selector',
      valid,
      message: valid ? 'Success selector matched' : 'Success selector not found',
    })
  }

  const successTexts = toStringArray(cfg.success_text)
  const failureTexts = toStringArray(cfg.failure_text)
  let pageText = ''
  if (successTexts.length || failureTexts.length) {
    try {
      pageText = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true) as string
    } catch {
      pageText = ''
    }
  }

  if (successTexts.length) {
    const valid = successTexts.some((text) => pageText.includes(text))
    if (valid) strongSuccessMatched = true
    checks.push({
      name: 'success_text',
      valid,
      message: valid ? 'Success text matched' : 'Success text not found',
    })
  }

  if (failureTexts.length) {
    const matched = failureTexts.some((text) => pageText.includes(text))
    checks.push({
      name: 'failure_text',
      valid: !matched,
      message: matched ? 'Failure text was found' : 'Failure text not found',
    })
  }

  try {
    const validation = await checkCrawlerValidateUrl(cfg, cookies)
    if (validation.check) {
      if (validation.check.valid) strongSuccessMatched = true
      checks.push(validation.check)
    }
  } catch (e) {
    checks.push({
      name: 'validate_url',
      valid: false,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  const requiredCookieCheck = checks.find((check) => check.name === 'required_cookies')
  const failureCheck = checks.find((check) => check.name === 'failure_text')
  const validateChecks = checks.filter((check) => check.name === 'validate_url')
  const hasStrongConditions = Boolean(urlPattern || successSelector || successTexts.length || firstString(cfg.validate_url, cfg.url))
  const success = checks.length > 0
    && (hasStrongConditions ? strongSuccessMatched : Boolean(requiredCookieCheck?.valid))
    && (!requiredCookieCheck || requiredCookieCheck.valid)
    && (!failureCheck || failureCheck.valid)
    && validateChecks.every((check) => check.valid)

  return {
    success,
    checks,
    captureDelayMs: toPositiveInt(cfg.capture_delay_ms, 1000),
  }
}

async function setCrawlerAuthWindowStatus(win: BrowserWindow, text: string): Promise<void> {
  if (win.isDestroyed()) return
  try {
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.getElementById('crawler-auth-status');
        if (el) el.textContent = ${JSON.stringify(text)};
      })()
    `, true)
  } catch {
    // Non-critical while the page is navigating or blocking script execution.
  }
}

async function validateCrawlerSession(
  rule: CrawlerRule,
  state: unknown,
): Promise<CrawlerSessionValidationResult> {
  const validateCfg = getCrawlerAuthCheckConfig(rule, 'validate')
  const validateUrl = firstString(validateCfg.validate_url, validateCfg.url, rule.validate_url)
  const typed = state as { cookies?: Array<{ name: string; value: string }>; url?: string }
  const cookies = typed.cookies ?? []
  const cookieHeader = cookieHeaderFromCookies(cookies)
  const checks: CrawlerSessionValidationCheck[] = []

  const requiredCookies = toStringArray(validateCfg.required_cookies)
  if (requiredCookies.length) {
    const cookieNames = new Set(cookies.map((cookie) => cookie.name))
    const missing = requiredCookies.filter((name) => !cookieNames.has(name))
    checks.push({
      name: 'required_cookies',
      valid: missing.length === 0,
      message: missing.length ? `Missing cookies: ${missing.join(', ')}` : 'Required cookies are present',
    })
  }

  const urlPattern = typeof validateCfg.url_pattern === 'string' ? validateCfg.url_pattern : ''
  if (urlPattern && typed.url) {
    const matched = matchCrawlerPattern(typed.url, urlPattern)
    checks.push({
      name: 'url_pattern',
      valid: matched,
      message: matched ? 'Session URL matched' : `Session URL did not match ${urlPattern}`,
    })
  }

  if (!validateUrl) {
    const valid = checks.length ? checks.every((check) => check.valid) : true
    return {
      valid,
      message: checks.length ? (valid ? 'Session validation passed' : 'Session validation failed') : 'No validate_url configured',
      checks,
    }
  }

  const method = typeof validateCfg.method === 'string' ? validateCfg.method.toUpperCase() : 'GET'
  const res = await fetch(validateUrl, {
    method,
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  })
  const body = await res.text()
  const successStatuses = toNumberArray(validateCfg.success_statuses)
  const statusOk = successStatuses.length ? successStatuses.includes(res.status) : res.ok
  checks.push({
    name: 'status',
    valid: statusOk,
    message: `HTTP ${res.status} ${res.statusText}`,
  })

  const successTexts = toStringArray(validateCfg.success_text)
  if (successTexts.length) {
    const matched = successTexts.some((text) => body.includes(text))
    checks.push({
      name: 'success_text',
      valid: matched,
      message: matched ? 'Success text matched' : 'Success text not found',
    })
  }

  const failureTexts = toStringArray(validateCfg.failure_text)
  if (failureTexts.length) {
    const matched = failureTexts.some((text) => body.includes(text))
    checks.push({
      name: 'failure_text',
      valid: !matched,
      message: matched ? 'Failure text was found' : 'Failure text not found',
    })
  }

  const valid = checks.every((check) => check.valid)
  return {
    valid,
    status: res.status,
    message: valid ? 'Session validation passed' : 'Session validation failed',
    checks,
  }
}

function registerIpcHandlers(): void {
  const db = getDatabase()

  // Phase 0
  registerHandler(IPC.PING, async () => pythonManager.ping())
  registerHandler(IPC.GET_PYTHON_STATUS, async () => ({ ready: pythonManager.isReady }))

  // Phase 1 - DB status
  registerHandler(IPC.DB_STATUS, async () => {
    const version = db.pragma('user_version', { simple: true }) as number
    return { ready: true, version }
  })

  // Phase 1 - Task CRUD
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

  // Phase 1 - App settings
  registerHandler(IPC.APP_GET_SETTINGS, async () => ({ ...appSettings }))
  registerHandler(IPC.APP_GET_STORAGE_PATHS, async () => getStorageSettingsPayload())
  registerHandler(IPC.APP_PICK_DIRECTORY, async (args) => {
    const { title, defaultPath } = (args ?? {}) as { title?: string; defaultPath?: string }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: title ?? '选择目录',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })
  registerHandler(IPC.APP_SET_STORAGE_PATHS, async (args) => updateStoragePaths(args as {
    dataRootDir?: string
  }))
  registerHandler(IPC.APP_RELAUNCH, async () => {
    setTimeout(() => {
      relaunchApplication()
    }, 150)
  })
  registerHandler(IPC.APP_SET_SETTING, async (args) => {
    const { key, value } = args as { key: string; value: unknown }
    appSettings[key] = value
    saveAppSettings()
  })

  // Phase 2 - Questions
  registerHandler(IPC.QUESTION_GROUP_LIST, async () => listQuestionGroups(db))
  registerHandler(IPC.QUESTION_GROUP_UPSERT, async (args) =>
    upsertQuestionGroup(db, args as Parameters<typeof upsertQuestionGroup>[1]))
  registerHandler(IPC.QUESTION_GROUP_DELETE, async (id) => deleteQuestionGroup(db, id as string))
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

  // Phase 2 - Practice
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

  // Phase 3 - Documents
  registerHandler(IPC.DOC_LIST, async () => listDocuments(db))

  registerHandler(IPC.DOC_PICK_FILE, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select PDF File',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return null

    const filePath = result.filePaths[0]
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath
    const title = fileName.replace(/\.pdf$/i, '')
    return { filePath, fileName, title }
  })

  registerHandler(IPC.DOC_PREVIEW, async (args) => {
    const {
      filePath,
      previewPage,
      topMarginRatio,
      bottomMarginRatio,
    } = args as {
      filePath: string
      previewPage: number
      topMarginRatio?: number
      bottomMarginRatio?: number
    }

    const previewRes = await fetch(`http://127.0.0.1:${pythonManager.port}/pdf/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({
        file_path: filePath,
        preview_page: previewPage,
        top_margin_ratio: topMarginRatio ?? 0.07,
        bottom_margin_ratio: bottomMarginRatio ?? 0.07,
      }),
    })
    if (!previewRes.ok) {
      const err = await previewRes.json() as { detail?: string }
      throw new Error(err.detail ?? 'PDF preview failed')
    }
    return previewRes.json()
  })

  registerHandler(IPC.DOC_IMPORT, async (args) => {
    const importArgs = (args ?? {}) as {
      filePath?: string
      topMarginRatio?: number
      bottomMarginRatio?: number
      startPage?: number
      endPage?: number | null
    }

    let filePath = importArgs.filePath
    if (!filePath) {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: 'Select PDF File',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        properties: ['openFile'],
      })
      if (result.canceled || !result.filePaths.length) return null
      filePath = result.filePaths[0]
    }

    const topMarginRatio = importArgs.topMarginRatio ?? 0.07
    const bottomMarginRatio = importArgs.bottomMarginRatio ?? 0.07
    const startPage = importArgs.startPage ?? 1
    const endPage = importArgs.endPage ?? null

    const fileName = filePath.split(/[\\/]/).pop() ?? filePath
    const title = fileName.replace(/\.pdf$/i, '')

    const startPdfParse = (doc: { id: string; file_path: string }, parseFilePath: string): string => {
      const taskId = taskManager!.createTask('pdf_import', {
        docId: doc.id,
        filePath: parseFilePath,
        topMarginRatio,
        bottomMarginRatio,
        startPage,
        endPage,
      })
      wsClient.connect(taskId)

      wsClient.onComplete(taskId, (_, result) => {
        const { page_count, chunks } = result as {
          page_count: number
          chunks: Array<{ doc_id: string; page_num: number; content: string; knowledge_tags: string[] }>
        }
        try {
          updateDocumentPageCount(db, doc.id, page_count)
          deleteDocChunks(db, doc.id)
          insertChunks(db, chunks)
          taskManager!.updateTask(taskId, 'completed', { chunkCount: chunks.length })
        } catch (e) {
          console.error('[DocImport] Failed to store chunks:', e)
        }
      })
      wsClient.onError(taskId, (_, error) => {
        taskManager!.updateTask(taskId, 'failed', { error })
      })

      fetch(`http://127.0.0.1:${pythonManager.port}/pdf/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
        body: JSON.stringify({
          file_path: parseFilePath,
          doc_id: doc.id,
          task_id: taskId,
          top_margin_ratio: topMarginRatio,
          bottom_margin_ratio: bottomMarginRatio,
          start_page: startPage,
          end_page: endPage,
        }),
      }).catch((e) => console.error('[DocImport] Python parse request failed:', e))

      return taskId
    }

    const md5Res = await fetch(`http://127.0.0.1:${pythonManager.port}/pdf/md5`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ file_path: filePath }),
    })
    const { md5 } = await md5Res.json() as { md5: string }

    const existing = getDocumentByMd5(db, md5)
    if (existing) {
      const chunkCount = getDocChunkCount(db, existing.id)
      if (existing.page_count > 0 && chunkCount > 0) {
        return { duplicate: true, document: existing }
      }

      const parseFilePath = existsSync(existing.file_path) ? existing.file_path : filePath
      const taskId = startPdfParse(existing, parseFilePath)
      return { document: existing, taskId, reparsing: true }
    }

    const managedFilePath = buildManagedDocumentPath(filePath, md5)
    if (normalize(resolve(filePath)) !== normalize(resolve(managedFilePath))) {
      mkdirSync(dirname(managedFilePath), { recursive: true })
      copyFileSync(filePath, managedFilePath)
    }

    const doc = insertDocument(db, { title, file_path: managedFilePath, page_count: 0, md5 })

    const taskId = startPdfParse(doc, managedFilePath)

    return { document: doc, taskId }
  })

  registerHandler(IPC.DOC_DELETE, async (id) => {
    const doc = getDocumentById(db, id as string)
    deleteDocument(db, id as string)
    if (doc && isPathInsideDirectory(doc.file_path, getStoragePaths().documentLibraryDir) && existsSync(doc.file_path)) {
      try { unlinkSync(doc.file_path) } catch { /* non-critical */ }
    }
  })
  registerHandler(IPC.DOC_GET_CHUNKS, async (docId) => getChunks(db, docId as string))

  // Phase 3 - AI config
  registerHandler(IPC.AI_GET_CONFIG, async () => {
    const cfg = buildProviderConfig() as Record<string, Record<string, unknown>>
    return {
      ...cfg,
      openai: { ...cfg.openai, encryptedApiKey: undefined },
      anthropic: { ...cfg.anthropic, encryptedApiKey: undefined },
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
      if (openai.apiKey && openai.apiKey !== MASKED_SECRET) {
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
      if (anthropic.apiKey && anthropic.apiKey !== MASKED_SECRET) {
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

  registerHandler(IPC.AI_TEST_CONNECTION, async (args) => {
    const cfg = buildProviderConfig((args ?? {}) as ProviderConfigOverride)
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
    const params = args as {
      count?: number
      types?: string[]
      knowledge_tags?: string[]
      difficulty?: number
      context?: string
      target_group_id?: string | null
      new_group?: QuestionGroupInput | null
    }
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

  // Phase 5 - Crawler
  registerHandler(IPC.CRAWLER_LIST_RULES, async () => listCrawlerRules(db))

  registerHandler(IPC.CRAWLER_UPSERT_RULE, async (args) =>
    upsertCrawlerRule(db, args as Parameters<typeof upsertCrawlerRule>[1]))

  registerHandler(IPC.CRAWLER_DELETE_RULE, async (id) => deleteCrawlerRule(db, id as string))

  registerHandler(IPC.CRAWLER_LIST_RUNS, async (ruleId) => listCrawlerRuns(db, ruleId as string))

  registerHandler(IPC.CRAWLER_TEST, async (args) => {
    const { rule, test_url, account_alias = null } = args as {
      rule: CrawlerRule
      test_url: string
      account_alias?: string | null
    }
    const session_state = getDecryptedCrawlerSessionPayload(db, rule, account_alias)
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/crawler/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ rule, test_url, account_alias, session_state }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string | { code?: string; message?: string } }
      const detail = typeof err.detail === 'object' ? err.detail : null
      throw Object.assign(
        new Error(detail?.message ?? String(err.detail ?? 'Test failed')),
        { code: detail?.code ?? 'CRAWLER_TEST_FAILED' }
      )
    }
    return res.json()
  })

  registerHandler(IPC.CRAWLER_RUN, async (args) => {
    const { ruleId, target_group_id = null, new_group = null, account_alias = null } = args as {
      ruleId: string
      target_group_id?: string | null
      new_group?: QuestionGroupInput | null
      account_alias?: string | null
    }
    const rules = listCrawlerRules(db)
    const rule = rules.find((r) => r.id === ruleId)
    if (!rule) throw Object.assign(new Error('Rule not found'), { code: 'NOT_FOUND' })
    const resolvedGroupId = resolveQuestionGroupId(db, { target_group_id, new_group }, 'crawled')

    const run = createCrawlerRun(db, ruleId, resolvedGroupId)
    const taskId = taskManager!.createTask('crawl', { ruleId, runId: run.id, target_group_id: resolvedGroupId })
    wsClient.connect(taskId)

    wsClient.onComplete(taskId, (_, result) => {
      const { questions, total_found } = result as {
        questions: NormalizedCrawlerPayload[]
        total_found: number
        rule_id: string
        target_group_id?: string | null
      }
      try {
        const saved = saveCrawlerReviewItems(db, {
          ruleId,
          runId: run.id,
          items: questions,
          targetGroupId: resolvedGroupId ?? target_group_id ?? null,
        })
        updateCrawlerRun(db, run.id, {
          status: 'completed',
          total_found,
          total_saved: 0,
          ended_at: new Date().toISOString(),
        })
        addCrawledCount(db, ruleId, saved)
        taskManager!.updateTask(taskId, 'completed', { saved })
      } catch (e) {
        console.error('[Crawler] Failed to save questions:', e)
      }
    })
    wsClient.onError(taskId, (_, error) => {
      const parsed = typeof error === 'object' && error
        ? error as { code?: string; stage?: string; message?: string }
        : null
      updateCrawlerRun(db, run.id, {
        status: 'failed',
        ended_at: new Date().toISOString(),
        error_code: parsed?.code,
        error_stage: parsed?.stage,
        error_msg: parsed?.message ?? String(error),
      })
      taskManager!.updateTask(taskId, 'failed', { error })
    })

    const session_state = getDecryptedCrawlerSessionPayload(db, rule, account_alias)
    fetch(`http://127.0.0.1:${pythonManager.port}/crawler/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({
        rule,
        task_id: taskId,
        rule_id: ruleId,
        target_group_id: resolvedGroupId,
        new_group,
        account_alias,
        session_state,
      }),
    }).catch((e) => console.error('[Crawler] Run request failed:', e))

    return { taskId, runId: run.id }
  })

  registerHandler(IPC.CRAWLER_AUTH_START, async (args) => {
    const { ruleId, account_alias = 'default' } = args as { ruleId: string; account_alias?: string }
    const rule = listCrawlerRules(db).find((item) => item.id === ruleId)
    if (!rule) throw Object.assign(new Error('Rule not found'), { code: 'NOT_FOUND' })
    return openCrawlerAuthWindow({ rule, accountAlias: account_alias || 'default' })
  })

  registerHandler(IPC.CRAWLER_LIST_SESSIONS, async (args) => {
    const { ruleId } = (args ?? {}) as { ruleId?: string }
    return listCrawlerSiteSessions(db, ruleId)
  })

  registerHandler(IPC.CRAWLER_VALIDATE_SESSION, async (args) => {
    const { ruleId, account_alias } = args as { ruleId: string; account_alias: string }
    const rule = listCrawlerRules(db).find((item) => item.id === ruleId)
    if (!rule) throw Object.assign(new Error('Rule not found'), { code: 'NOT_FOUND' })
    const state = getDecryptedCrawlerSessionPayload(db, rule, account_alias)
    if (!state) throw Object.assign(new Error('Session not found'), { code: 'CRAWLER_AUTH_INVALID' })
    const result = await validateCrawlerSession(rule, state)
    if (result.valid) touchCrawlerSiteSessionValidation(db, getCrawlerSiteId(rule), account_alias)
    return result
  })

  registerHandler(IPC.CRAWLER_DELETE_SESSION, async (args) => {
    const { ruleId, account_alias } = args as { ruleId: string; account_alias: string }
    deleteCrawlerSiteSession(db, ruleId, account_alias)
  })

  registerHandler(IPC.CRAWLER_INSPECT_LOAD, async (args) => {
    const { rule, url = null, account_alias = null } = args as {
      rule: CrawlerRule
      url?: string | null
      account_alias?: string | null
    }
    const session_state = getDecryptedCrawlerSessionPayload(db, rule, account_alias)
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/crawler/inspect/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ rule, url, account_alias, session_state }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string | { code?: string; message?: string } }
      const detail = typeof err.detail === 'object' ? err.detail : null
      throw Object.assign(
        new Error(detail?.message ?? String(err.detail ?? 'Inspect load failed')),
        { code: detail?.code ?? 'CRAWLER_INSPECT_LOAD_FAILED' }
      )
    }
    return res.json()
  })

  registerHandler(IPC.CRAWLER_SUGGEST_SELECTOR, async (args) => {
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/crawler/inspect/suggest-selector`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify(args ?? {}),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string | { code?: string; message?: string } }
      const detail = typeof err.detail === 'object' ? err.detail : null
      throw Object.assign(
        new Error(detail?.message ?? String(err.detail ?? 'Selector suggestion failed')),
        { code: detail?.code ?? 'CRAWLER_SELECTOR_FAILED' }
      )
    }
    return res.json()
  })

  registerHandler(IPC.CRAWLER_RUNTIME_STATUS, async () => {
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/crawler/runtime/status`, {
      method: 'GET',
      headers: { 'X-Internal-Token': pythonManager.token },
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string | { code?: string; message?: string } }
      const detail = typeof err.detail === 'object' ? err.detail : null
      throw Object.assign(
        new Error(detail?.message ?? String(err.detail ?? 'Runtime status failed')),
        { code: detail?.code ?? 'CRAWLER_RUNTIME_STATUS_FAILED' }
      )
    }
    return res.json()
  })

  registerHandler(IPC.CRAWLER_INSPECT_PREVIEW, async (args) => {
    const { rule, html = null, url = null, account_alias = null } = args as {
      rule: CrawlerRule
      html?: string | null
      url?: string | null
      account_alias?: string | null
    }
    const session_state = getDecryptedCrawlerSessionPayload(db, rule, account_alias)
    const res = await fetch(`http://127.0.0.1:${pythonManager.port}/crawler/inspect/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': pythonManager.token },
      body: JSON.stringify({ rule, html, url, account_alias, session_state }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string | { code?: string; message?: string } }
      const detail = typeof err.detail === 'object' ? err.detail : null
      throw Object.assign(
        new Error(detail?.message ?? String(err.detail ?? 'Inspect preview failed')),
        { code: detail?.code ?? 'CRAWLER_INSPECT_PREVIEW_FAILED' }
      )
    }
    return res.json()
  })

  registerHandler(IPC.CRAWLER_LIST_REVIEW_ITEMS, async (args) =>
    listCrawlerReviewItems(db, args as Parameters<typeof listCrawlerReviewItems>[1]))

  registerHandler(IPC.CRAWLER_REJECT_REVIEW_ITEMS, async (args) => {
    const { ids, notes = '' } = args as { ids: string[]; notes?: string }
    updateCrawlerReviewStatus(db, ids, 'rejected', notes)
  })

  registerHandler(IPC.CRAWLER_IMPORT_REVIEW_ITEMS, async (args) => {
    const { ids, target_group_id = null, new_group = null } = args as {
      ids: string[]
      target_group_id?: string | null
      new_group?: QuestionGroupInput | null
    }
    const items = getCrawlerReviewItemsByIds(db, ids)
      .filter((item) => item.review_status === 'pending' || item.review_status === 'approved')
    const fallbackGroupId = resolveQuestionGroupId(db, { target_group_id, new_group }, 'crawled')
    const questions = items.map((item) => ({
      ...item.normalized_payload,
      source_type: 'crawled',
      group_id: fallbackGroupId ?? item.target_group_id ?? null,
    })) as Parameters<typeof batchInsertQuestions>[1]
    const saved = batchInsertQuestions(db, questions)
    updateCrawlerReviewStatus(db, items.map((item) => item.id), 'imported')

    const byRun = new Map<string, number>()
    for (const item of items) byRun.set(item.run_id, (byRun.get(item.run_id) ?? 0) + 1)
    for (const [runId, count] of byRun) {
      const run = db.prepare('SELECT total_saved FROM crawler_runs WHERE id=?').get(runId) as { total_saved: number } | undefined
      updateCrawlerRun(db, runId, { total_saved: (run?.total_saved ?? 0) + count })
    }

    return { count: saved }
  })

  // Phase 5 - Knowledge Graph (computed in main process from SQLite)
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

  // Phase 5 - Essay
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

  // Phase 5 - AI Chat with RAG (FTS5 doc context)
  registerHandler(IPC.AI_CHAT_SESSIONS_LIST, async (args) => {
    const { limit = 100 } = (args ?? {}) as { limit?: number }
    const sessions = listAiChatSessions(db, limit)
    if (sessions.length > 0) return sessions
    return [createAiChatSession(db)]
  })

  registerHandler(IPC.AI_CHAT_SESSION_CREATE, async (args) => {
    const { title } = (args ?? {}) as { title?: string }
    return createAiChatSession(db, title)
  })

  registerHandler(IPC.AI_CHAT_SESSION_DELETE, async (sessionId) => {
    deleteAiChatSession(db, sessionId as string)
    if (!getLatestAiChatSession(db)) {
      createAiChatSession(db)
    }
  })

  registerHandler(IPC.AI_CHAT_MESSAGES_LIST, async (args) => {
    const { sessionId, limit = 100 } = args as { sessionId: string; limit?: number }
    return listAiChatMessages(db, sessionId, limit)
  })

  registerHandler(IPC.AI_CHAT, async (args) => {
    const { sessionId, question, useDocContext = true } = args as {
      sessionId: string
      question: string
      useDocContext?: boolean
    }
    const session = getAiChatSession(db, sessionId)
    if (!session) throw Object.assign(new Error('Chat session not found'), { code: 'AI_CHAT_SESSION_NOT_FOUND' })

    let docChunks: unknown[] = []
    const history = listAiChatMessages(db, sessionId, 12).map((item) => ({
      role: item.role,
      content: item.content,
    }))

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
      body: JSON.stringify({ ai_config: buildProviderConfig(), question, history, doc_chunks: docChunks }),
    })
    if (!res.ok) {
      const err = await res.json() as { detail?: string }
      throw Object.assign(new Error(err.detail ?? 'Chat failed'), { code: 'AI_CHAT_FAILED' })
    }
    const payload = await res.json() as { answer: string; sources: Array<{ page_num: number | null; doc_title: string }> }
    insertAiChatMessage(db, { session_id: sessionId, role: 'user', content: question })
    insertAiChatMessage(db, {
      session_id: sessionId,
      role: 'assistant',
      content: payload.answer,
      sources: payload.sources,
    })
    return payload
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

  // Phase 4 - Study Plans
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

  // Phase 4 - Study Sessions
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

  // Phase 6 - Achievements
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

  // Phase 6 - Backup & Restore
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
    const dbPath = getStoragePaths().databasePath
    const walPath = `${dbPath}-wal`
    const shmPath = `${dbPath}-shm`
    const tempEncryptedPath = `${dbPath}.restore-encrypted`

    // Close DB, copy backup over current DB, reopen
    closeDatabase()
    try {
      if (existsSync(walPath)) rmSync(walPath, { force: true })
      if (existsSync(shmPath)) rmSync(shmPath, { force: true })

      if (existsSync(dbPath)) rmSync(dbPath, { force: true })
      if (isPlainSqliteFile(backupPath)) {
        const dbKey = await getOrCreateDatabaseKey()
        if (existsSync(tempEncryptedPath)) rmSync(tempEncryptedPath, { force: true })

        const sourceDb = new Database(backupPath)
        sourceDb.pragma("key=''");
        const escapedTempPath = tempEncryptedPath.replace(/'/g, "''")
        const escapedKey = dbKey.replace(/'/g, "''")
        sourceDb.exec(`
          ATTACH DATABASE '${escapedTempPath}' AS encrypted KEY '${escapedKey}';
          SELECT sqlcipher_export('encrypted');
          DETACH DATABASE encrypted;
        `)
        sourceDb.close()

        copyFileSync(tempEncryptedPath, dbPath)
        rmSync(tempEncryptedPath, { force: true })
      } else {
        copyFileSync(backupPath, dbPath)
      }
    } catch (e) {
      console.error('[Backup] Restore failed:', e)
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

  migrateLegacyUserDataIfNeeded()
  loadStoragePathConfig()
  ensureStorageDirectories()
  verifySQLCipher()
  loadAppSettings()
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
  mainWindow.on('closed', () => {
    mainWindow = null
    cleanupAppResources()
    if (process.platform !== 'darwin') app.quit()
  })

  pythonManager.start(mainWindow).then(() => {
    if (!mainWindow || resourcesCleanedUp) return
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

app.on('before-quit', () => {
  cleanupAppResources()
})

app.on('window-all-closed', () => {
  cleanupAppResources()
  if (process.platform !== 'darwin') app.quit()
})

