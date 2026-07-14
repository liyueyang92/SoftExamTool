/**
 * Helpers for launching and closing the Electron app in E2E tests.
 * Each test suite gets an isolated userData directory so tests don't interfere.
 */
import { _electron as electron, ElectronApplication, Page } from 'playwright-core'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'

export interface AppHandle {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

// Lazy-started mock server — avoids cross-process env/file sharing issues.
// Each worker calls ensureMockServer() once; the first call starts the server.
let _mockPort = 0
let _mockClose: (() => void) | null = null

/** Ensure a mock AI server is running and return its port. Returns 0 on failure. */
export async function ensureMockServer(): Promise<number> {
  if (_mockPort) return _mockPort
  try {
    // Dynamic import to avoid loading the server module unless needed
    const { startMockAIServer } = await import('./mock-server')
    const { port, close } = await startMockAIServer()
    _mockPort = port
    _mockClose = close
    console.log(`[E2E] Mock AI server started on port ${port} (worker-initiated)`)
    return port
  } catch {
    return 0
  }
}

/** Stop the mock server if it was started by this worker. */
export function stopMockServer(): void {
  if (_mockClose) {
    _mockClose()
    _mockClose = null
    _mockPort = 0
  }
}

/**
 * @deprecated Use `await ensureMockServer()` instead.
 * Synchronously returns the cached port; may be 0 if not yet started.
 */
export function getMockPort(): number {
  return _mockPort
}

/**
 * Pre-seed an AI config JSON so the app points to the mock server.
 * Must be called before launchApp so the config is ready when the app reads it.
 */
export function seedAiConfig(userDataDir: string, mockPort: number): void {
  fs.mkdirSync(userDataDir, { recursive: true })
  const cfg = {
    mode: 'openai',
    openai: {
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      model: 'mock-gpt',
      encryptedApiKey: null,
    },
    ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5' },
  }
  fs.writeFileSync(path.join(userDataDir, 'ai-config.json'), JSON.stringify(cfg))
}

/** Launch the built Electron app with an isolated userData dir. */
export async function launchApp(opts?: { userDataDir?: string }): Promise<AppHandle> {
  const userDataDir =
    opts?.userDataDir ?? path.join(os.tmpdir(), `softexam-e2e-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(userDataDir, { recursive: true })

  // Point at the compiled main entry (built by electron-vite build)
  const mainEntry = path.resolve(__dirname, '../../../out/main/index.js')

  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Suppress auto-backup on first launch
      E2E_TEST: '1',
    },
    timeout: 30_000,
  })

  // Wait for the first window
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  return { app, page, userDataDir }
}

/** Wait until the Python service status shows "已就绪" (ready). */
export async function waitForPythonReady(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.status-dot')
      return el?.classList.contains('ok') || el?.getAttribute('title')?.includes('运行中')
    },
    { timeout },
  )
}

/** Gracefully close the app and clean up the temp userData dir. */
export async function closeApp(handle: AppHandle, cleanup = true): Promise<void> {
  await handle.app.close()
  if (cleanup && handle.userDataDir.includes('softexam-e2e-')) {
    fs.rmSync(handle.userDataDir, { recursive: true, force: true })
  }
}
