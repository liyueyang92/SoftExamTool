import { BrowserWindow } from 'electron'
import { IPC } from './ipc-channels'

interface WsMessage {
  type?: 'progress' | 'complete' | 'error' | 'partial'
  taskId: string
  progress?: number
  message?: string
  result?: unknown
  error?: unknown
  // partial page data
  pageNum?: number
  totalPages?: number
  chunks?: Array<{
    doc_id: string; page_num: number; content: string
    knowledge_tags: string[]
    chunk_type?: string; asset_id?: string | null
    confidence?: number; source_engine?: string
    block_order?: number; bbox?: string | null
  }>
  assets?: Array<{
    id: string; doc_id: string; page_num: number
    asset_type: string; file_path: string
    width: number; height: number; bbox: string; content_hash: string
  }>
  warnings?: Array<{ page_num: number; code: string; message: string }>
}

interface Connection {
  ws: WebSocket
  taskId: string
  retryDelay: number
  retryTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

type CompleteCallback = (taskId: string, result: unknown) => void
type ErrorCallback = (taskId: string, error: unknown) => void
type PartialCallback = (taskId: string, pageNum: number, totalPages: number,
  chunks: WsMessage['chunks'], assets: WsMessage['assets'], warnings: WsMessage['warnings']) => void

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error) {
    return (error as { message?: string }).message ?? JSON.stringify(error)
  }
  return String(error ?? 'Unknown error')
}

export class WsProgressClient {
  private connections = new Map<string, Connection>()
  private completeCallbacks = new Map<string, CompleteCallback>()
  private errorCallbacks = new Map<string, ErrorCallback>()
  private partialCallbacks = new Map<string, PartialCallback>()
  private port = 0
  private token = ''
  private mainWindow: BrowserWindow | null = null

  init(port: number, token: string, mainWindow: BrowserWindow): void {
    this.port = port
    this.token = token
    this.mainWindow = mainWindow
  }

  connect(taskId: string): void {
    if (this.connections.has(taskId)) return
    this.openConnection(taskId, 1000)
  }

  onComplete(taskId: string, cb: CompleteCallback): void {
    this.completeCallbacks.set(taskId, cb)
  }

  onError(taskId: string, cb: ErrorCallback): void {
    this.errorCallbacks.set(taskId, cb)
  }

  onPartial(taskId: string, cb: PartialCallback): void {
    this.partialCallbacks.set(taskId, cb)
  }

  private openConnection(taskId: string, retryDelay: number): void {
    const url = `ws://127.0.0.1:${this.port}/ws/progress/${taskId}?token=${this.token}`
    const ws = new WebSocket(url)
    const conn: Connection = { ws, taskId, retryDelay, retryTimer: null, closed: false }
    this.connections.set(taskId, conn)

    ws.addEventListener('open', () => {
      console.log(`[WsClient] Connected for task ${taskId}`)
      conn.retryDelay = 1000
    })

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage
        const type = msg.type ?? 'progress'

        if (type === 'complete') {
          this.mainWindow?.webContents.send(IPC.TASK_PROGRESS, {
            taskId: msg.taskId,
            progress: 100,
            message: 'Done',
          })
          const cb = this.completeCallbacks.get(taskId)
          if (cb) {
            cb(msg.taskId, msg.result)
            this.completeCallbacks.delete(taskId)
          }
          this.disconnect(taskId)
          return
        }

        if (type === 'error') {
          this.mainWindow?.webContents.send(IPC.TASK_PROGRESS, {
            taskId: msg.taskId,
            progress: 0,
            message: errorMessage(msg.error),
          })
          const cb = this.errorCallbacks.get(taskId)
          if (cb) {
            cb(msg.taskId, msg.error)
            this.errorCallbacks.delete(taskId)
          }
          this.disconnect(taskId)
          return
        }

        if (type === 'partial') {
          // 转发页面中间结果到渲染进程
          this.mainWindow?.webContents.send(IPC.TASK_PARTIAL, {
            taskId: msg.taskId,
            pageNum: msg.pageNum,
            totalPages: msg.totalPages,
            chunks: msg.chunks ?? [],
            assets: msg.assets ?? [],
            warnings: msg.warnings ?? [],
          })
          const cb = this.partialCallbacks.get(taskId)
          if (cb) {
            cb(msg.taskId, msg.pageNum ?? 0, msg.totalPages ?? 0,
              msg.chunks, msg.assets, msg.warnings)
          }
          return
        }

        this.mainWindow?.webContents.send(IPC.TASK_PROGRESS, {
          taskId: msg.taskId,
          progress: msg.progress ?? 0,
          message: msg.message ?? '',
        })
      } catch {
        // Ignore malformed progress messages.
      }
    })

    ws.addEventListener('close', () => {
      if (conn.closed) return
      const delay = Math.min(conn.retryDelay * 2, 30_000)
      console.log(`[WsClient] task ${taskId} disconnected, retry in ${delay}ms`)
      conn.retryTimer = setTimeout(() => {
        this.connections.delete(taskId)
        this.openConnection(taskId, delay)
      }, delay)
    })

    ws.addEventListener('error', (e) => {
      console.warn(`[WsClient] task ${taskId} error:`, e)
    })
  }

  disconnect(taskId: string): void {
    const conn = this.connections.get(taskId)
    if (!conn) return
    conn.closed = true
    if (conn.retryTimer) clearTimeout(conn.retryTimer)
    conn.ws.close()
    this.connections.delete(taskId)
  }

  disconnectAll(): void {
    for (const taskId of [...this.connections.keys()]) this.disconnect(taskId)
  }
}
