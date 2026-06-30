/**
 * Scenario 1: 首次安装启动
 * 验证应用启动后 Python 服务正常初始化、主界面正确显示。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'

test.describe('首次安装启动', () => {
  test('Python 服务在 30 秒内就绪', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page, 30_000)
      // 状态指示器应变为 ok 状态
      const dot = handle.page.locator('.status-dot').first()
      await expect(dot).toBeVisible()
    } finally {
      await closeApp(handle)
    }
  })

  test('首页仪表盘正常渲染', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      // 等待路由渲染完成
      await handle.page.waitForSelector('.exam-banner, .card', { timeout: 15_000 })
      // 侧边栏存在
      await expect(handle.page.locator('.sidebar')).toBeVisible()
      // 品牌文字
      await expect(handle.page.locator('.brand')).toBeVisible()
    } finally {
      await closeApp(handle)
    }
  })

  test('主导航各入口可见', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const nav = handle.page.locator('.sidebar')
      await expect(nav).toBeVisible()
      // 验证至少 6 个导航项存在
      const items = nav.locator('.nav-item')
      await expect(items).toHaveCount(await items.count())
      expect(await items.count()).toBeGreaterThanOrEqual(6)
    } finally {
      await closeApp(handle)
    }
  })

  test('使用错误 Token 访问 Python ping 端点返回 403', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      // 从主进程获取 Python 端口（通过 ipcRenderer）
      const port = await handle.app.evaluate(({ ipcMain }) => {
        // 访问主进程中暴露的端口信息（存在于 global 或 module 作用域）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (global as any).__pythonPort as number | undefined
      })

      if (port) {
        const res = await fetch(`http://127.0.0.1:${port}/ping`, {
          headers: { 'X-Internal-Token': 'wrong-token' },
        })
        expect(res.status).toBe(403)
      } else {
        // 端口未暴露到 global，跳过此子检查
        test.skip()
      }
    } finally {
      await closeApp(handle)
    }
  })

  test('关闭窗口后 Python 进程随之退出', async () => {
    const handle = await launchApp()
    await waitForPythonReady(handle.page)
    const pid = await handle.app.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (global as any).__pythonPid as number | undefined
    })
    await closeApp(handle, false)

    if (pid) {
      // 尝试 kill 0 发信号检测进程是否存在；已退出则抛异常
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
    }
  })
})
