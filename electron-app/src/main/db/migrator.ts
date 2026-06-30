import Database from 'better-sqlite3-multiple-ciphers'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const MIGRATIONS_DIR = join(__dirname, 'migrations')

export function runMigrations(db: InstanceType<typeof Database>): void {
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  let version = currentVersion
  for (const file of files) {
    const fileVersion = parseInt(file.split('_')[0], 10)
    if (fileVersion <= version) continue

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')
    console.log(`[DB] Running migration ${file}`)
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${fileVersion}`)
    })()
    version = fileVersion
  }

  if (version > currentVersion) {
    console.log(`[DB] Migrated from v${currentVersion} to v${version}`)
  } else {
    console.log(`[DB] Schema up to date at v${version}`)
  }
}
