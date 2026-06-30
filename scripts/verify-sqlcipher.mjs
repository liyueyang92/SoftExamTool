/**
 * SQLCipher (better-sqlite3-multiple-ciphers) 编译验证脚本
 * 从 electron-app/ 目录运行：node ../scripts/verify-sqlcipher.mjs
 */
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { unlinkSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'

// 解析相对于 electron-app/ 的模块（脚本在 scripts/ 里，electron-app 是同级目录）
const __dir = dirname(fileURLToPath(import.meta.url))
const electronAppDir = resolve(__dir, '../electron-app')
const require = createRequire(join(electronAppDir, 'package.json'))

const Database = require('better-sqlite3-multiple-ciphers')

const dbPath = join(tmpdir(), `verify-sqlcipher-${process.pid}.db`)

try {
  const db = new Database(dbPath)
  db.pragma("key='test-encryption-key-32bytes!!'")
  db.exec('CREATE TABLE t (v TEXT NOT NULL)')
  db.prepare('INSERT INTO t VALUES (?)').run('sqlcipher-ok')
  const row = db.prepare('SELECT v FROM t').get()
  if (row.v !== 'sqlcipher-ok') throw new Error(`Unexpected value: ${row.v}`)
  db.close()

  // 验证加密有效：错误密钥应无法读取
  const db2 = new Database(dbPath)
  db2.pragma("key='wrong-key'")
  let encryptionWorks = false
  try {
    db2.prepare('SELECT v FROM t').get()
  } catch {
    encryptionWorks = true
  }
  db2.close()

  console.log('✓ better-sqlite3-multiple-ciphers 编译成功')
  console.log('✓ 加密写入与读取正常')
  console.log(encryptionWorks ? '✓ 错误密钥无法读取数据（加密有效）' : '⚠ 加密可能未生效，请检查 pragma key 调用时机')
} finally {
  if (existsSync(dbPath)) unlinkSync(dbPath)
}
