import Database from 'better-sqlite3-multiple-ciphers'
import crypto from 'crypto'
import { join } from 'path'
import { existsSync } from 'fs'
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { runMigrations } from './migrator'

const SERVICE = 'soft-exam-tool'
const ACCOUNT = 'db-encryption-key'

async function getOrCreateKey(dbExists: boolean): Promise<string> {
  // Try keytar first (Windows Credential Manager)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keytar = require('keytar') as typeof import('keytar')
    if (dbExists) {
      const stored = await keytar.getPassword(SERVICE, ACCOUNT)
      if (stored) return stored
    }
    const key = crypto.randomBytes(32).toString('hex')
    await keytar.setPassword(SERVICE, ACCOUNT, key)
    console.log('[DB] Key stored in Windows Credential Manager via keytar')
    return key
  } catch (e) {
    console.warn('[DB] keytar unavailable, falling back to safeStorage:', (e as Error).message)
  }

  // Fallback: safeStorage (Chromium-managed OS keychain)
  const keyFile = join(app.getPath('userData'), 'db.key.enc')
  if (dbExists && existsSync(keyFile)) {
    const encrypted = readFileSync(keyFile)
    return safeStorage.decryptString(encrypted)
  }
  const key = crypto.randomBytes(32).toString('hex')
  const encrypted = safeStorage.encryptString(key)
  writeFileSync(keyFile, encrypted)
  console.log('[DB] Key stored via safeStorage fallback')
  return key
}

let _db: InstanceType<typeof Database> | null = null

export async function initDatabase(): Promise<InstanceType<typeof Database>> {
  if (_db) return _db

  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'app.db')
  const dbExists = existsSync(dbPath)

  const key = await getOrCreateKey(dbExists)

  const db = new Database(dbPath)
  db.pragma(`key='${key}'`)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

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
