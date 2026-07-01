import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { createServer } from 'net'
import crypto from 'crypto'
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { IPC } from './ipc-channels'

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number }
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

export class PythonManager {
  private process: ChildProcess | null = null
  port = 0
  token = ''
  private ready = false
  get isReady(): boolean { return this.ready }
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  async start(mainWindow: BrowserWindow): Promise<void> {
    // If INTERNAL_PORT + INTERNAL_TOKEN are pre-set (e.g. by dev-start.ps1),
    // skip spawning and connect to the already-running external process.
    const externalPort = parseInt(process.env.INTERNAL_PORT ?? '', 10)
    const externalToken = process.env.INTERNAL_TOKEN ?? ''
    if (externalPort && externalToken) {
      console.log(`[Python] External mode — connecting to pre-started service on port ${externalPort}`)
      this.port = externalPort
      this.token = externalToken
      this.startPolling(mainWindow)
      return
    }

    this.port = await findFreePort()
    this.token = crypto.randomBytes(32).toString('hex')

    // __dirname = electron-app/out/main/ (both dev and prod builds)
    // project root (containing python-service/) = electron-app/../../.. → soft/
    const projectRoot = join(__dirname, '../../..')
    const pythonExe = is.dev
      ? join(projectRoot, 'python-service/.venv/Scripts/python.exe')
      : join(process.resourcesPath, 'python-service/python-service.exe')

    const args = is.dev ? [join(projectRoot, 'python-service/main.py')] : []

    this.process = spawn(pythonExe, args, {
      env: {
        ...process.env,
        INTERNAL_PORT: String(this.port),
        INTERNAL_TOKEN: this.token
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.process.stdout?.on('data', (d) => process.stdout.write(`[Python] ${d}`))
    this.process.stderr?.on('data', (d) => process.stderr.write(`[Python] ${d}`))
    this.process.on('exit', (code) => {
      console.log(`[Python] exited with code ${code}`)
      this.ready = false
      this.stopPolling()
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.PYTHON_STATUS, { ready: false })
      }
    })

    this.startPolling(mainWindow)
  }

  private startPolling(mainWindow: BrowserWindow): void {
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
          headers: { 'x-internal-token': this.token },
          signal: AbortSignal.timeout(2000)
        })
        if (res.ok && !this.ready) {
          this.ready = true
          console.log('[Python] service ready on port', this.port)
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.PYTHON_STATUS, { ready: true })
          }
          return
        }
      } catch {
        // not ready yet
      }
      this.pollTimer = setTimeout(poll, 1000)
    }
    poll()
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  async ping(): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${this.port}/ping`, {
      headers: { 'x-internal-token': this.token },
      signal: AbortSignal.timeout(5000)
    })
    const data = (await res.json()) as { message: string }
    return data.message
  }

  stop(): void {
    this.stopPolling()
    this.process?.kill()
    this.process = null
  }
}
