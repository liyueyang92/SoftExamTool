import Database from 'better-sqlite3-multiple-ciphers'
import crypto from 'crypto'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { runMigrations } from './migrator'

const SERVICE = 'soft-exam-tool'
const ACCOUNT = 'db-encryption-key'

// Returns the stored key, or null if not found in this store.
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
  const keyFile = join(app.getPath('userData'), 'db.key.enc')

  // --- Look up existing key ---
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
    // Key is gone but DB file exists — it cannot be opened. Remove it so a
    // fresh encrypted database is created on the next open.
    console.warn('[DB] Encryption key not found for existing database — resetting database file')
    unlinkSync(dbPath)
  }

  // --- Create a new key ---
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

let _db: InstanceType<typeof Database> | null = null

export async function initDatabase(): Promise<InstanceType<typeof Database>> {
  if (_db) return _db

  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'app.db')

  const key = await getOrCreateKey(dbPath)

  function configureDb(db: InstanceType<typeof Database>, k: string): void {
    db.pragma(`key='${k}'`)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }

  let rawDb = new Database(dbPath)
  try {
    configureDb(rawDb, key)
  } catch (e) {
    rawDb.close()  // release file handle before any unlink
    if ((e as NodeJS.ErrnoException & { code?: string }).code === 'SQLITE_NOTADB') {
      // Stored key does not match the database — wipe both and start fresh.
      console.warn('[DB] Stored key mismatch — resetting database and key store')
      unlinkSync(dbPath)
      const keyFile = join(app.getPath('userData'), 'db.key.enc')
      if (existsSync(keyFile)) unlinkSync(keyFile)
      const freshKey = await getOrCreateKey(dbPath)
      rawDb = new Database(dbPath)
      configureDb(rawDb, freshKey)
    } else {
      throw e
    }
  }
  const db = rawDb

  runMigrations(db)
  _db = db
  console.log('[DB] Initialized at', dbPath)
  return db
}

export function getDatabase(): InstanceType<typeof Database> {
  if (!_db) throw new Error('Database not initialized — call initDatabase() first')
  return _db
}

export function closeDatabase(): void {
  _db?.close()
  _db = null
}
