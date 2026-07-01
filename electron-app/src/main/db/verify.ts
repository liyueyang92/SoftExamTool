import Database from 'better-sqlite3-multiple-ciphers'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync, existsSync, writeFileSync } from 'fs'

export const SQLCIPHER_RESULT_FILE = join(tmpdir(), 'sqlcipher-phase0-result.json')

export function verifySQLCipher(): void {
  const dbPath = join(tmpdir(), `sqlcipher-verify-${process.pid}.db`)
  try {
    const db = new Database(dbPath)
    db.pragma("key='phase0-verify-key-32bytes!!!'")
    db.exec('CREATE TABLE t (v TEXT NOT NULL)')
    db.prepare('INSERT INTO t VALUES (?)').run('ok')
    const row = db.prepare('SELECT v FROM t').get() as { v: string }
    db.close()

    if (row.v === 'ok') {
      console.log('[SQLCipher] OK - better-sqlite3-multiple-ciphers encrypted r/w verified')
      writeFileSync(SQLCIPHER_RESULT_FILE, JSON.stringify({ ok: true, value: row.v }))
    } else {
      console.error('[SQLCipher] FAIL - unexpected value:', row.v)
      writeFileSync(SQLCIPHER_RESULT_FILE, JSON.stringify({ ok: false, value: row.v }))
    }
  } catch (e) {
    console.error('[SQLCipher] FAIL - verify error:', e)
    writeFileSync(SQLCIPHER_RESULT_FILE, JSON.stringify({ ok: false, error: String(e) }))
  } finally {
    if (existsSync(dbPath)) unlinkSync(dbPath)
  }
}
