import Database from 'better-sqlite3-multiple-ciphers'
import { randomUUID } from 'crypto'
import { copyFileSync, statSync, existsSync, unlinkSync } from 'fs'
import { basename, isAbsolute, join, normalize, relative, resolve } from 'path'
import { getStoragePaths } from '../storage-paths'

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

function isPathInsideDirectory(filePath: string, dirPath: string): boolean {
  const rel = relative(resolve(dirPath), resolve(filePath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function createBackup(
  db: Database.Database,
  destDir: string,
  note = ''
): BackupRecord {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fileName = `softexam-backup-${ts}.db`
  const destPath = join(destDir, fileName)

  db.pragma('wal_checkpoint(TRUNCATE)')
  copyFileSync(getDbPath(), destPath)

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

export function remapManagedBackupPaths(
  db: Database.Database,
  fromDir: string,
  toDir: string,
): number {
  const backups = listBackups(db)
  const updateStmt = db.prepare('UPDATE backup_records SET file_path = ? WHERE id = ?')
  let changed = 0

  const updateAll = db.transaction(() => {
    for (const rec of backups) {
      if (!isPathInsideDirectory(rec.file_path, fromDir)) continue
      const rel = relative(normalize(resolve(fromDir)), normalize(resolve(rec.file_path)))
      updateStmt.run(resolve(toDir, rel), rec.id)
      changed += 1
    }
  })
  updateAll()

  return changed
}

export function getDbPath(): string {
  return getStoragePaths().databasePath
}

export function getDefaultBackupDir(): string {
  return getStoragePaths().backupDir
}

export { basename }
