import { _electron as electron } from 'playwright-core'
import path from 'path'
import fs from 'fs'

const APP_DIR = 'D:/Documents/localRep/soft/electron-app'
const SHOT_DIR = 'C:/tmp/shots'
fs.mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe')
const appEntry  = path.join(APP_DIR, 'out/main/index.js')

// Capture main-process output
const mainLog = []
const app = await electron.launch({
  executablePath: electronBin,
  args: [appEntry],
  timeout: 60_000,
})
app.process().stdout.on('data', d => mainLog.push('[OUT] ' + d.toString().trim()))
app.process().stderr.on('data', d => mainLog.push('[ERR] ' + d.toString().trim()))

const page = await app.firstWindow({ timeout: 30_000 })
await page.waitForLoadState('domcontentloaded')

// ── 1. Wait for Python ready ──────────────────────────────────────────────────
console.log('[Check 1] Waiting for Python ready…')
try {
  await page.waitForFunction(
    () => document.querySelector('.status-dot.ok') !== null,
    { timeout: 25_000 }
  )
  console.log('[✓] Python service ready (status-dot.ok visible)')
} catch {
  console.log('[✗] Python not ready within 25s')
}
await page.screenshot({ path: SHOT_DIR + '/01-python-ready.png' })

// ── 2. Wait for DB ready ──────────────────────────────────────────────────────
console.log('[Check 2] Waiting for DB ready…')
try {
  await page.waitForFunction(
    () => document.querySelector('.db-badge.ok') !== null,
    { timeout: 15_000 }
  )
  const dbText = await page.evaluate(() => document.querySelector('.db-badge')?.textContent)
  console.log('[✓] DB ready:', dbText)
} catch {
  console.log('[✗] DB not ready within 15s')
  const dbText = await page.evaluate(() => document.querySelector('.db-badge')?.textContent)
  console.log('    DB badge text:', dbText)
}
await page.screenshot({ path: SHOT_DIR + '/02-db-ready.png' })

// ── 3. Navigation: click through each nav item ────────────────────────────────
console.log('[Check 3] Navigation…')
const navRoutes = [
  ['题库',   '#/questions'],
  ['练习',   '#/practice'],
  ['学习计划','#/plans'],
  ['AI助手', '#/ai'],
  ['文档库', '#/documents'],
  ['设置',   '#/settings'],
  ['仪表盘', '#/'],
]
for (const [label, expectedHash] of navRoutes) {
  await page.evaluate((text) => {
    const links = [...document.querySelectorAll('.nav-item')]
    const el = links.find(l => l.textContent?.includes(text))
    if (el) el.click()
  }, label)
  await new Promise(r => setTimeout(r, 300))
  const url = page.url()
  const ok = url.includes(expectedHash)
  console.log(`  ${ok ? '[✓]' : '[✗]'} ${label} → ${url.split('#')[1] ?? url}`)
}
await page.screenshot({ path: SHOT_DIR + '/03-nav.png' })

// ── 4. Dark mode toggle ───────────────────────────────────────────────────────
console.log('[Check 4] Dark mode toggle…')
const wasDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
await page.evaluate(() => document.querySelector('.dark-toggle')?.click())
await new Promise(r => setTimeout(r, 300))
const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
console.log(wasDark !== isDark ? '[✓] Dark mode toggled' : '[✗] Dark mode did not toggle')
// toggle back
await page.evaluate(() => document.querySelector('.dark-toggle')?.click())
await page.screenshot({ path: SHOT_DIR + '/04-dark-mode.png' })

// ── 5. Task create via IPC ────────────────────────────────────────────────────
console.log('[Check 5] Task create…')
const taskResult = await page.evaluate(async () => {
  try {
    const r = await window.electronAPI.createTask({ type: 'test', payload: { hello: 'world' } })
    return r
  } catch (e) {
    return { error: String(e) }
  }
})
if (taskResult.success) {
  console.log('[✓] Task created, id:', taskResult.data.id)
  // fetch it back
  const getResult = await page.evaluate(async (id) => {
    const r = await window.electronAPI.getTask(id)
    return r
  }, taskResult.data.id)
  console.log('    getTask:', getResult.success ? getResult.data?.status : getResult.error?.message)
} else {
  console.log('[✗] Task create failed:', taskResult.error?.message)
}

// ── 6. IPC timeout (ping with very short timeout) ─────────────────────────────
console.log('[Check 6] IPC response format…')
const pingResult = await page.evaluate(async () => {
  try {
    return await window.electronAPI.ping()
  } catch (e) {
    return { error: String(e) }
  }
})
console.log(pingResult.success ? '[✓] Ping IPC success: ' + pingResult.data : '[✗] Ping failed: ' + JSON.stringify(pingResult))

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n=== Main process logs ===')
mainLog.filter(l => l.includes('[DB]') || l.includes('[App]') || l.includes('[Python] service') || l.includes('[TaskManager]'))
       .forEach(l => console.log(l))

await app.close()
console.log('[DONE]')
