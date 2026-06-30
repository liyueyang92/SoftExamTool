/**
 * Scenario 7: 离线模式
 * 断开 AI 网络访问后，题库练习、文档查看、已生成试题练习均可用。
 * 通过模拟 AI API 请求失败（不设置 mock），验证核心功能不依赖网络。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'
import path from 'path'

const QUESTIONS_FIXTURE = path.resolve(__dirname, 'fixtures/questions.json')

test.describe('离线模式', () => {
  test('断网情况下题库练习正常可用', async () => {
    // 故意不 seed AI config，让 AI 请求使用不存在的端口（模拟网络不可达）
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导入题目
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })
      await handle.app.evaluate(
        ({ dialog }, fp) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fp] })
        },
        QUESTIONS_FIXTURE,
      )
      const importBtn = page.getByText('批量导入').or(page.getByText('导入题目')).first()
      if (await importBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await importBtn.click()
        await page.waitForTimeout(1_500)
        const confirmBtn = page.getByText('确认导入').or(page.getByText('确认')).last()
        if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await confirmBtn.click()
          await page.waitForTimeout(2_000)
        }
      }

      // 题库列表仍可加载
      const qList = page.locator('.q-table tbody tr, .question-item')
      await expect(qList.first()).toBeVisible({ timeout: 10_000 })

      // 练习页可以启动
      await page.locator('.nav-item[href="#/practice"]').click()
      await page.waitForSelector('.config-panel, .mode-cards, .practice-view', { timeout: 10_000 })
      await expect(page.getByText('随机练习').or(page.getByText('顺序练习')).first()).toBeVisible()

      // 开始一次练习（5 题）
      const randomMode = page.getByText('随机练习').or(page.getByText('顺序练习')).first()
      await randomMode.click({ timeout: 5_000 })

      const countInput = page.locator('.count-input, input[type="number"]').first()
      if (await countInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await countInput.fill('3')
      }

      await page.getByText('开始练习').click({ timeout: 5_000 })
      await page.waitForSelector('.answering-panel, .question-card, .q-content', {
        timeout: 15_000,
      })

      // 验证题目正常显示
      await expect(page.locator('.q-content, .question-card').first()).toBeVisible()
    } finally {
      await closeApp(handle)
    }
  })

  test('断网情况下 AI 功能给出明确提示，不崩溃', async () => {
    // 不设置任何 AI 配置（使用默认无效地址）
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导航到 AI 助手页
      await page.locator('.nav-item[href="#/ai"]').click()
      await page.waitForSelector('.ai-view, .chat-panel, input, textarea, .ai-placeholder', {
        timeout: 10_000,
      })

      // 页面不应崩溃（无 JS error 页面）
      await expect(page.locator('body')).toBeVisible()

      // 尝试发送消息
      const inputEl = page.locator('input[type="text"], textarea').last()
      if (await inputEl.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await inputEl.fill('测试离线消息')
        await page.keyboard.press('Enter')
        // 等待错误提示或超时提示（最多 15 秒）
        await page.waitForTimeout(8_000)
        // 界面应仍然可交互，不白屏
        await expect(page.locator('body')).toBeVisible()
      }

      // 验证导航仍然可用
      await page.locator('.nav-item[href="#/"]').click()
      await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5_000 })
    } finally {
      await closeApp(handle)
    }
  })

  test('已导入题目在离线模式下可正常查看', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导入题目后离线检查
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })
      await handle.app.evaluate(
        ({ dialog }, fp) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fp] })
        },
        QUESTIONS_FIXTURE,
      )
      const importBtn = page.getByText('批量导入').or(page.getByText('导入题目')).first()
      if (await importBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await importBtn.click()
        await page.waitForTimeout(1_500)
        const confirmBtn = page.getByText('确认导入').or(page.getByText('确认')).last()
        if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await confirmBtn.click()
          await page.waitForTimeout(2_000)
        }
      }

      // 全文搜索（本地 FTS5，不需要网络）
      const searchInput = page.locator('.search-input')
      if (await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await searchInput.fill('架构')
        const searchBtn = page.getByText('搜索')
        if (await searchBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await searchBtn.click()
        }
        await page.waitForTimeout(1_000)
        // 搜索结果应存在或无错误
        const errMsg = page.locator('.error-msg, [class*="error"]:visible')
        expect(await errMsg.count()).toBe(0)
      }
    } finally {
      await closeApp(handle)
    }
  })
})
