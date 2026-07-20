import { spawn, spawnSync, ChildProcess } from 'child_process'
import { join, resolve } from 'path'
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
  private externalMode = false
  private projectRoot = ''
  port = 0
  token = ''
  private ready = false
  get isReady(): boolean { return this.ready }
  get pythonPid(): number | null { return this.process?.pid ?? null }
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  async start(mainWindow: BrowserWindow): Promise<void> {
    this.projectRoot = resolve(join(__dirname, '../../..'))

    // If INTERNAL_PORT + INTERNAL_TOKEN are pre-set (e.g. by dev-start.ps1),
    // skip spawning and connect to the already-running external process.
    const externalPort = parseInt(process.env.INTERNAL_PORT ?? '', 10)
    const externalToken = process.env.INTERNAL_TOKEN ?? ''
    if (externalPort && externalToken) {
      console.log(`[Python] External mode: connecting to pre-started service on port ${externalPort}`)
      this.externalMode = true
      this.port = externalPort
      this.token = externalToken
      this.startPolling(mainWindow)
      return
    }

    this.port = await findFreePort()
    this.token = crypto.randomBytes(32).toString('hex')

    // __dirname = electron-app/out/main/ (both dev and prod builds)
    // project root (containing python-service/) = electron-app/../../..
    const projectRoot = this.projectRoot
    const useSourcePython = is.dev || process.env.E2E_TEST === '1'
    const pythonExe = useSourcePython
      ? join(projectRoot, 'python-service/.venv/Scripts/python.exe')
      : join(process.resourcesPath, 'python-service/python-service.exe')

    const args = useSourcePython ? [join(projectRoot, 'python-service/main.py')] : []

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

  private killProcessTree(pid: number): void {
    if (!pid || pid <= 0) return

    if (process.platform === 'win32') {
      // 使用异步 spawn 代替 spawnSync，避免 taskkill 阻塞主进程事件循环。
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      child.on('error', (err) => console.warn('[Python] taskkill failed:', err))
      return
    }

    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Process may have already exited.
    }
  }

  private findListeningPid(port: number): number | null {
    if (process.platform !== 'win32') return null

    const command = [
      '$conn = Get-NetTCPConnection',
      `-LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen`,
      '-ErrorAction SilentlyContinue | Select-Object -First 1;',
      'if ($conn) { $conn.OwningProcess }',
    ].join(' ')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
    const pid = Number.parseInt(result.stdout.trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  }

  private findOwnedProjectProcessInChain(pid: number): number | null {
    if (process.platform !== 'win32') return null

    const command = `
      $targetPid = ${pid};
      $items = @();
      while ($targetPid -and $targetPid -gt 0) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue;
        if (-not $p) { break }
        $items += [pscustomobject]@{
          ProcessId = $p.ProcessId;
          ParentProcessId = $p.ParentProcessId;
          ExecutablePath = $p.ExecutablePath;
          CommandLine = $p.CommandLine
        };
        $targetPid = $p.ParentProcessId;
      }
      $items | ConvertTo-Json -Depth 3
    `
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
    if (!result.stdout.trim()) return null

    let chain: Array<{ ProcessId: number; ExecutablePath?: string; CommandLine?: string }>
    try {
      const parsed = JSON.parse(result.stdout) as unknown
      chain = Array.isArray(parsed) ? parsed as typeof chain : [parsed as typeof chain[number]]
    } catch {
      return null
    }

    const normalizedProjectRoot = this.projectRoot.toLowerCase()
    const owned = chain.find((entry) => {
      const haystack = `${entry.ExecutablePath ?? ''}\n${entry.CommandLine ?? ''}`.toLowerCase()
      return haystack.includes(normalizedProjectRoot) || haystack.includes('python-service')
    })
    return owned?.ProcessId ?? null
  }

  private stopExternalServiceIfOwned(): void {
    const listeningPid = this.findListeningPid(this.port)
    if (!listeningPid) return

    const ownedPid = this.findOwnedProjectProcessInChain(listeningPid)
    if (!ownedPid) {
      console.warn(`[Python] External service on port ${this.port} is not owned by this app; leaving it running`)
      return
    }

    console.log(`[Python] Stopping external service tree at PID ${ownedPid}`)
    this.killProcessTree(ownedPid)
  }

  stop(): void {
    this.stopPolling()
    if (this.process?.pid) {
      console.log(`[Python] Stopping spawned process tree at PID ${this.process.pid}`)
      this.killProcessTree(this.process.pid)
    } else if (this.externalMode) {
      console.log(`[Python] External mode: stopping service on port ${this.port}`)
      this.stopExternalServiceIfOwned()
    }
    this.process = null
    this.ready = false
  }
}
