import Database from 'better-sqlite3-multiple-ciphers'
import crypto from 'crypto'
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { safeStorage } from 'electron'
import { runMigrations } from './migrator'
import { ensureStorageDirectories, getStoragePaths } from '../storage-paths'

const SERVICE = 'soft-exam-tool'
const ACCOUNT = 'db-encryption-key'

async function getKeytarKey(): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keytar = require('keytar') as typeof import('keytar')
    return await keytar.getPassword(SERVICE, ACCOUNT)
  } catch {
    return null
  }
}

async function storeKeytarKey(key: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keytar = require('keytar') as typeof import('keytar')
    await keytar.setPassword(SERVICE, ACCOUNT, key)
    return true
  } catch {
    return false
  }
}

async function getOrCreateKey(dbPath: string): Promise<string> {
  const dbExists = existsSync(dbPath)
  const keyFile = getStoragePaths().databaseKeyPath

  if (dbExists) {
    const fromKeytar = await getKeytarKey()
    if (fromKeytar) {
      console.log('[DB] Key loaded from Windows Credential Manager')
      return fromKeytar
    }

    if (existsSync(keyFile)) {
      try {
        console.log('[DB] Key loaded from safeStorage fallback')
        return safeStorage.decryptString(readFileSync(keyFile))
      } catch (e) {
        console.warn('[DB] safeStorage key unreadable:', (e as Error).message)
      }
    }

    console.warn('[DB] Encryption key not found for existing database; resetting database file')
    unlinkSync(dbPath)
  }

  const key = crypto.randomBytes(32).toString('hex')
  const storedInKeytar = await storeKeytarKey(key)
  if (storedInKeytar) {
    console.log('[DB] New key stored in Windows Credential Manager')
  } else {
    const encrypted = safeStorage.encryptString(key)
    writeFileSync(keyFile, encrypted)
    console.log('[DB] New key stored via safeStorage fallback')
  }
  return key
}

let dbInstance: InstanceType<typeof Database> | null = null

export async function initDatabase(): Promise<InstanceType<typeof Database>> {
  if (dbInstance) return dbInstance

  const paths = getStoragePaths()
  ensureStorageDirectories(paths)
  const dbPath = paths.databasePath
  const key = await getOrCreateKey(dbPath)

  function configureDb(db: InstanceType<typeof Database>, value: string): void {
    db.pragma(`key='${value}'`)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }

  let rawDb = new Database(dbPath)
  try {
    configureDb(rawDb, key)
  } catch (e) {
    rawDb.close()
    if ((e as NodeJS.ErrnoException & { code?: string }).code === 'SQLITE_NOTADB') {
      console.warn('[DB] Stored key mismatch; resetting database and key store')
      unlinkSync(dbPath)
      const keyFile = getStoragePaths().databaseKeyPath
      if (existsSync(keyFile)) unlinkSync(keyFile)
      const freshKey = await getOrCreateKey(dbPath)
      rawDb = new Database(dbPath)
      configureDb(rawDb, freshKey)
    } else {
      throw e
    }
  }

  runMigrations(rawDb)
  dbInstance = rawDb
  console.log('[DB] Initialized at', dbPath)
  return rawDb
}

export function getDatabase(): InstanceType<typeof Database> {
  if (!dbInstance) throw new Error('Database not initialized; call initDatabase() first')
  return dbInstance
}

export function closeDatabase(): void {
  dbInstance?.close()
  dbInstance = null
}
