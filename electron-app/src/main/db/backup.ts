import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'
import { statSync, existsSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { app } from 'electron'

export interface BackupRecord {
  id: string
  file_path: string
  size_bytes: number
  note: string
  created_at: string
}

export function listBackups(db: Database.Database): BackupRecord[] {
  return db.prepare('SELECT * FROM backup_records ORDER BY created_at DESC').all() as BackupRecord[]
}

export function deleteBackupRecord(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM backup_records WHERE id = ?').run(id)
}

export async function createBackup(
  db: Database.Database,
  destDir: string,
  note = ''
): Promise<BackupRecord> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fileName = `softexam-backup-${ts}.db`
  const destPath = join(destDir, fileName)

  // better-sqlite3 async backup (hot backup, WAL-safe)
  await (db as unknown as { backup: (dest: string) => Promise<void> }).backup(destPath)

  const size = existsSync(destPath) ? statSync(destPath).size : 0
  const id = randomUUID()

  db.prepare(`
    INSERT INTO backup_records (id, file_path, size_bytes, note) VALUES (?, ?, ?, ?)
  `).run(id, destPath, size, note)

  return { id, file_path: destPath, size_bytes: size, note, created_at: new Date().toISOString() }
}

export function getLastBackupTime(db: Database.Database): string | null {
  const row = db.prepare('SELECT created_at FROM backup_records ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined
  return row?.created_at ?? null
}

export function shouldAutoBackup(db: Database.Database): boolean {
  const last = getLastBackupTime(db)
  if (!last) return true
  const elapsed = Date.now() - new Date(last).getTime()
  return elapsed > 24 * 60 * 60 * 1000 // 24 hours
}

export function pruneOldBackups(db: Database.Database, keepCount = 7): void {
  const all = listBackups(db)
  if (all.length <= keepCount) return

  const toDelete = all.slice(keepCount)
  for (const rec of toDelete) {
    try {
      if (existsSync(rec.file_path)) unlinkSync(rec.file_path)
    } catch { /* non-critical */ }
    deleteBackupRecord(db, rec.id)
  }
}

export function getDbPath(): string {
  return join(app.getPath('userData'), 'softexam.db')
}

export function getDefaultBackupDir(): string {
  return join(app.getPath('userData'), 'backups')
}

export { basename }
