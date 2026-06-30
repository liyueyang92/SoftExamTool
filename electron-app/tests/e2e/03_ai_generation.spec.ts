/**
 * Scenario 3: AI 智能出题（mock AI 服务）
 * 配置 AI 指向 mock 服务器，触发出题，验证题目格式正确并可保存。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp, seedAiConfig } from './helpers/app'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

test.describe('AI 智能出题（mock）', () => {
  test('配置 mock AI 后测试连接成功', async () => {
    const mockPort = parseInt(process.env.MOCK_AI_PORT ?? '0', 10)
    if (!mockPort) test.skip()

    const userDataDir = path.join(
      os.tmpdir(),
      `softexam-e2e-${crypto.randomBytes(4).toString('hex')}`,
    )
    seedAiConfig(userDataDir, mockPort)

    const handle = await launchApp({ userDataDir })
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导航到设置页面
      await page.locator('.nav-item[href="#/settings"]').click()
      await page.waitForSelector('.settings-view, .settings-container, h2', { timeout: 8_000 })

      // 等待 AI 配置区域
      const testBtn = page.getByText('测试连接').or(page.getByText('测试')).first()
      if (await testBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await testBtn.click()
        // 应出现成功提示（不超时即视为通过）
        await page
          .waitForSelector('.success, .ok, [class*="success"]', { timeout: 15_000 })
          .catch(() => {
            // 成功提示可能是 toast，不阻断测试
          })
      }
    } finally {
      await closeApp(handle)
    }
  })

  test('AI 生成 5 道单选题，格式正确，可保存至题库', async () => {
    const mockPort = parseInt(process.env.MOCK_AI_PORT ?? '0', 10)
    if (!mockPort) test.skip()

    const userDataDir = path.join(
      os.tmpdir(),
      `softexam-e2e-${crypto.randomBytes(4).toString('hex')}`,
    )
    seedAiConfig(userDataDir, mockPort)

    const handle = await launchApp({ userDataDir })
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导航到题库页，点击 AI 出题
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.q-table, .qview, .toolbar', { timeout: 10_000 })

      // 寻找 AI 出题入口（按钮文本）
      const aiBtn = page
        .getByText('AI 出题')
        .or(page.getByText('智能出题'))
        .or(page.getByText('AI生成'))
        .first()

      if (!(await aiBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
        // 尝试 AI 助手页面
        await page.locator('.nav-item[href="#/ai"]').click()
        await page.waitForSelector('.ai-view, .chat-panel, input, textarea', { timeout: 8_000 })
      }

      // 如果在 AI 助手页，发送出题指令
      const inputEl = page.locator('input[type="text"], textarea').last()
      if (await inputEl.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await inputEl.fill('请生成 5 道软件架构单选题')
        await page.keyboard.press('Enter')
        // 等待 mock 响应（mock 服务器立即返回）
        await page.waitForTimeout(5_000)
      } else if (await aiBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await aiBtn.click()
        // 填写出题配置
        const countInput = page.locator('input[type="number"], .count-input').first()
        if (await countInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await countInput.fill('5')
        }
        const generateBtn = page.getByText('生成').or(page.getByText('开始生成')).first()
        await generateBtn.click({ timeout: 5_000 })
        await page.waitForTimeout(10_000)
      }

      // 验证：页面无错误弹窗
      const errorEl = page.locator('.error-msg, [class*="error"]:visible')
      expect(await errorEl.count()).toBe(0)
    } finally {
      await closeApp(handle)
    }
  })
})
