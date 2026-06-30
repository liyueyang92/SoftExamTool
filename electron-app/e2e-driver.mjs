import { _electron as electron } from 'playwright-core'
import path from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = __dirname
const SHOT_DIR = 'C:/tmp/shots'
mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = path.join(APP_DIR, 'node_modules/electron/dist/electron.exe')
const appEntry = path.join(APP_DIR, 'out/main/index.js')

console.log('Launching Electron...')
console.log('  bin:', electronBin)
console.log('  entry:', appEntry)

const app = await electron.launch({
  executablePath: electronBin,
  args: [appEntry],
  timeout: 60000,
})

console.log('Launch succeeded, waiting for window...')

const page = await app.firstWindow({ timeout: 30000 })
console.log('Window URL:', page.url())

await page.waitForLoadState('domcontentloaded')
await new Promise(r => setTimeout(r, 2000))

await page.screenshot({ path: SHOT_DIR + '/01-initial.png' })
console.log('[SHOT] 01-initial.png saved to', SHOT_DIR)

const bodyText = await page.evaluate(() => document.body.innerText)
console.log('[PAGE TEXT]', bodyText.replace(/\n/g, ' | '))

// Wait for Python ready (up to 20s)
const hasReady = bodyText.includes('已就绪')
if (!hasReady) {
  try {
    await page.waitForFunction(
      () => document.querySelector('.status-card')?.textContent?.includes('已就绪'),
      { timeout: 20000 }
    )
    console.log('[OK] Python service READY')
  } catch {
    console.log('[WARN] Python service not ready within 20s')
  }
} else {
  console.log('[OK] Python service already READY')
}

await page.screenshot({ path: SHOT_DIR + '/02-ready.png' })
console.log('[SHOT] 02-ready.png saved')

// Click Ping button
const pingBtn = await page.$('.ping-btn:not([disabled])')
if (pingBtn) {
  await pingBtn.evaluate(el => el.click())
  try {
    await page.waitForFunction(() => document.querySelector('.result') !== null, { timeout: 8000 })
    const result = await page.evaluate(() => document.querySelector('.result')?.textContent)
    console.log('[PING RESULT]', result)
    await page.screenshot({ path: SHOT_DIR + '/03-pong.png' })
    console.log('[SHOT] 03-pong.png saved')
  } catch {
    console.log('[WARN] No ping result within 8s')
    await page.screenshot({ path: SHOT_DIR + '/03-timeout.png' })
  }
} else {
  console.log('[WARN] Ping button not available')
  await page.screenshot({ path: SHOT_DIR + '/03-no-button.png' })
}

await app.close()
console.log('[DONE]')
