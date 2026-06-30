import { ipcMain } from 'electron'

export type IpcResponse<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } }

export function registerHandler<T>(
  channel: string,
  fn: (args: unknown) => Promise<T>
): void {
  ipcMain.handle(channel, async (_, args): Promise<IpcResponse<T>> => {
    try {
      const data = await fn(args)
      return { success: true, data }
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string }
      return {
        success: false,
        error: { code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) }
      }
    }
  })
}
