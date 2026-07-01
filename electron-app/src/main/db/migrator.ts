import Database from 'better-sqlite3-multiple-ciphers'
import { MIGRATIONS } from './schema'

export function runMigrations(db: InstanceType<typeof Database>): void {
  const currentVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0

  let version = currentVersion
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue

    console.log(`[DB] Applying migration v${migration.version}`)
    db.transaction(() => {
      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.version}`)
    })()
    version = migration.version
  }

  if (version > currentVersion) {
    console.log(`[DB] Migrated from v${currentVersion} to v${version}`)
  } else {
    console.log(`[DB] Schema up to date at v${version}`)
  }
}
