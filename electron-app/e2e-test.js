/**
 * Phase 0 端到端测试 — 在 Electron 主进程上下文中运行
 * 验证：SQLCipher、Python 健康检查、Ping 链路、403 鉴权
 */
const { app } = require('electron')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')

let passed = 0
let failed = 0

function ok(label, cond, detail = '') {
  if (cond) { console.log(`[PASS] ${label}${detail ? ' — ' + detail : ''}`); passed++ }
  else { console.error(`[FAIL] ${label}${detail ? ' — ' + detail : ''}`); failed++ }
}

app.whenReady().then(async () => {
  console.log('\n=== Phase 0 E2E Tests ===\n')

  // ── Test 1: SQLCipher ──────────────────────────────────────────────────────
  try {
    const Database = require('better-sqlite3-multiple-ciphers')
    const dbPath = path.join(os.tmpdir(), `e2e-${process.pid}.db`)
    const db = new Database(dbPath)
    db.pragma("key='e2e-32byte-key-for-phase0-test!!'")
    db.exec('CREATE TABLE t (v TEXT)')
    db.prepare('INSERT INTO t VALUES (?)').run('sqlcipher-ok')
    const row = db.prepare('SELECT v FROM t').get()
    db.close()
    fs.unlinkSync(dbPath)
    ok('SQLCipher 加密读写', row.v === 'sqlcipher-ok', row.v)
  } catch (e) {
    ok('SQLCipher 加密读写', false, e.message)
  }

  // ── Test 2–4: Python 服务 ──────────────────────────────────────────────────
  const port = await new Promise(res => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
  const token = crypto.randomBytes(16).toString('hex')

  const venvPython = path.join(__dirname, '../python-service/.venv/Scripts/python.exe')
  const pyMain = path.join(__dirname, '../python-service/main.py')

  const py = spawn(venvPython, [pyMain], {
    env: { ...process.env, INTERNAL_PORT: String(port), INTERNAL_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  py.stdout.on('data', d => process.stdout.write('[PY] ' + d))
  py.stderr.on('data', d => process.stderr.write('[PY] ' + d))

  // 等待 /health 就绪（最多 15s）
  let ready = false
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) { ready = true; break }
    } catch {}
  }
  ok('Python 服务启动', ready, `port ${port}`)

  if (ready) {
    // /ping 带正确 Token
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, {
        headers: { 'x-internal-token': token }
      })
      const d = await r.json()
      ok('Python /ping 正确 Token', d.message === 'pong', JSON.stringify(d))
    } catch (e) { ok('Python /ping 正确 Token', false, e.message) }

    // /ping 无 Token → 403
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`)
      ok('Python /ping 无 Token → 403', r.status === 403, `status ${r.status}`)
    } catch (e) { ok('Python /ping 无 Token → 403', false, e.message) }

    // /health 无 Token → 200（豁免）
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const d = await r.json()
      ok('Python /health 无 Token 可访问', r.status === 200, `status ${r.status}, ${JSON.stringify(d)}`)
    } catch (e) { ok('Python /health 无 Token 可访问', false, e.message) }
  }

  py.kill()

  // ── 结果汇总 ────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
  app.exit(failed > 0 ? 1 : 0)
})
