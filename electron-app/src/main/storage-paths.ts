import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'

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
