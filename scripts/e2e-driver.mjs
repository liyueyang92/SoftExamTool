import { _electron as electron } from 'playwright-core'
import path from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '../electron-app')
const SHOT_DIR = '/tmp/shots'
mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe')
const appEntry = path.join(APP_DIR, 'out/main/index.js')

console.log('Launching Electron...')
console.log('  bin:', electronBin)
console.log('  entry:', appEntry)

const app = await electron.launch({
  executablePath: electronBin,
  args: [appEntry],
  timeout: 30000,
})

console.log('Launched. Waiting for first window...')
const page = await app.firstWindow()
console.log('Window URL:', page.url())

// Step 1: wait for status card to render
await page.waitForSelector('.status-card', { timeout: 20000 })
await page.screenshot({ path: SHOT_DIR + '/01-initial.png' })
console.log('[SHOT] 01-initial.png')

const initialStatus = await page.locator('.status-card').innerText()
console.log('[STATUS]', initialStatus.trim())

// Step 2: wait for Python service ready (up to 20s)
let pythonReady = false
try {
  await page.waitForSelector('.status-card.ready', { timeout: 20000 })
  pythonReady = true
  console.log('[OK] Python service READY')
} catch {
  console.log('[WARN] Python service not ready within 20s')
}

await page.screenshot({ path: SHOT_DIR + '/02-after-ready.png' })
console.log('[SHOT] 02-after-ready.png')

// Step 3: click Ping
if (pythonReady) {
  const btn = page.locator('.ping-btn')
  await btn.evaluate(el => el.click())
  try {
    await page.waitForSelector('.result', { timeout: 8000 })
    const result = await page.locator('.result').innerText()
    console.log('[PING RESULT]', result)
    await page.screenshot({ path: SHOT_DIR + '/03-pong.png' })
    console.log('[SHOT] 03-pong.png')
  } catch {
    console.log('[WARN] No ping result within 8s')
  }
}

await app.close()
console.log('[DONE]')
