import { app } from 'electron'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'

export interface StoragePathConfig {
  dataRootDir?: string
}

export interface ResolvedStoragePaths {
  bootstrapConfigPath: string
  defaultDataRootDir: string
  dataRootDir: string
  aiConfigPath: string
  appSettingsPath: string
  databasePath: string
  databaseKeyPath: string
  documentLibraryDir: string
  backupDir: string
}

let storagePathConfig: StoragePathConfig = {}

function normalizeDirectory(input?: string): string | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return resolve(trimmed)
}

function getBootstrapConfigPath(): string {
  return join(app.getPath('userData'), 'storage-paths.json')
}

function hasDataArtifacts(rootDir: string): boolean {
  const entries = [
    'storage-paths.json',
    'app.db',
    'ai-config.json',
    'app-settings.json',
    'db.key.enc',
    'documents',
    'backups',
  ]
  return entries.some((name) => existsSync(join(rootDir, name)))
}

export function migrateLegacyUserDataIfNeeded(): void {
  const currentUserDataDir = resolve(app.getPath('userData'))
  if (hasDataArtifacts(currentUserDataDir)) return

  const currentBaseName = basename(currentUserDataDir).toLowerCase()
  if (currentBaseName === 'electron-app') return

  const legacyUserDataDir = join(dirname(currentUserDataDir), 'electron-app')
  if (!existsSync(legacyUserDataDir) || !hasDataArtifacts(legacyUserDataDir)) return

  mkdirSync(currentUserDataDir, { recursive: true })

  const legacyBootstrap = join(legacyUserDataDir, 'storage-paths.json')
  const currentBootstrap = join(currentUserDataDir, 'storage-paths.json')
  if (existsSync(legacyBootstrap)) {
    copyFileSync(legacyBootstrap, currentBootstrap)
    return
  }

  for (const name of ['app.db', 'ai-config.json', 'app-settings.json', 'db.key.enc']) {
    const source = join(legacyUserDataDir, name)
    if (existsSync(source)) copyFileSync(source, join(currentUserDataDir, name))
  }
  for (const name of ['documents', 'backups']) {
    const source = join(legacyUserDataDir, name)
    if (existsSync(source)) cpSync(source, join(currentUserDataDir, name), { recursive: true, force: false, errorOnExist: false })
  }
}

export function loadStoragePathConfig(): StoragePathConfig {
  const configPath = getBootstrapConfigPath()
  if (!existsSync(configPath)) {
    storagePathConfig = {}
    return storagePathConfig
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as StoragePathConfig & { documentLibraryDir?: string }
    storagePathConfig = {
      dataRootDir: normalizeDirectory(parsed.dataRootDir),
    }
  } catch {
    storagePathConfig = {}
  }
  return storagePathConfig
}

export function saveStoragePathConfig(config: StoragePathConfig): void {
  storagePathConfig = {
    dataRootDir: normalizeDirectory(config.dataRootDir),
  }

  const configPath = getBootstrapConfigPath()
  const hasCustomConfig = Boolean(storagePathConfig.dataRootDir)
  if (!hasCustomConfig) {
    if (existsSync(configPath)) unlinkSync(configPath)
    return
  }

  writeFileSync(configPath, JSON.stringify(storagePathConfig, null, 2), 'utf-8')
}

export function resolveStoragePaths(configOverride?: StoragePathConfig): ResolvedStoragePaths {
  const bootstrapConfigPath = getBootstrapConfigPath()
  const defaultDataRootDir = resolve(app.getPath('userData'))
  const dataRootDir = normalizeDirectory(configOverride?.dataRootDir ?? storagePathConfig.dataRootDir) ?? defaultDataRootDir
  const documentLibraryDir = join(dataRootDir, 'documents')

  return {
    bootstrapConfigPath,
    defaultDataRootDir,
    dataRootDir,
    aiConfigPath: join(dataRootDir, 'ai-config.json'),
    appSettingsPath: join(dataRootDir, 'app-settings.json'),
    databasePath: join(dataRootDir, 'app.db'),
    databaseKeyPath: join(dataRootDir, 'db.key.enc'),
    documentLibraryDir,
    backupDir: join(dataRootDir, 'backups'),
  }
}

export function getStoragePaths(): ResolvedStoragePaths {
  return resolveStoragePaths()
}

export function ensureStorageDirectories(paths = getStoragePaths()): void {
  mkdirSync(paths.dataRootDir, { recursive: true })
  mkdirSync(paths.documentLibraryDir, { recursive: true })
  mkdirSync(paths.backupDir, { recursive: true })
}

export function getStoragePathConfig(): StoragePathConfig {
  return { ...storagePathConfig }
}
