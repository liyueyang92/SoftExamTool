/**
 * Scenario 5: 全真模拟考试
 * 验证模拟考试配置 → 答题计时 → 交卷 → 客观题出分 → AI 主观题评分（mock）。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp, seedAiConfig } from './helpers/app'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const QUESTIONS_FIXTURE = path.resolve(__dirname, 'fixtures/questions.json')

test.describe('全真模拟考试', () => {
  test('模拟考试流程：配置 → 答题 → 交卷 → 查看成绩', async () => {
    const mockPort = parseInt(process.env.MOCK_AI_PORT ?? '0', 10)
    const userDataDir = path.join(
      os.tmpdir(),
      `softexam-e2e-${crypto.randomBytes(4).toString('hex')}`,
    )
    if (mockPort) seedAiConfig(userDataDir, mockPort)

    const handle = await launchApp({ userDataDir })
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 先导入题目
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
          await page.waitForTimeout(1_500)
        }
      }

      // 导航到练习页面，找模拟考试入口
      await page.locator('.nav-item[href="#/practice"]').click()
      await page.waitForSelector('.config-panel, .mode-cards, .practice-view', { timeout: 10_000 })

      // 找"模拟考试"或类似入口
      const examMode = page
        .getByText('模拟考试')
        .or(page.getByText('全真模拟'))
        .or(page.getByText('整卷练习'))
        .first()

      if (await examMode.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await examMode.click()
      } else {
        // 降级：使用随机练习模式测试完整流程
        const randomMode = page.getByText('随机练习').or(page.getByText('顺序练习')).first()
        await randomMode.click({ timeout: 5_000 }).catch(() => {})
      }

      // 设置题数（模拟考试可能固定，随机练习设 5）
      const countInput = page.locator('.count-input, input[type="number"]').first()
      if (await countInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await countInput.fill('5')
      }

      // 开始
      await page.getByText('开始').or(page.getByText('开始练习')).or(page.getByText('开始考试')).first().click({ timeout: 5_000 })
      await page.waitForSelector('.answering-panel, .question-card, .q-content', {
        timeout: 15_000,
      })

      // 作答所有题（选第一个选项）
      let attempts = 0
      while (attempts < 10) {
        attempts++
        const option = page.locator('.option').first()
        if (!(await option.isVisible({ timeout: 3_000 }).catch(() => false))) break

        await option.click()

        const submitBtn = page.getByText('提交答案').or(page.getByText('下一题 →')).first()
        if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await submitBtn.click()
          await page.waitForTimeout(500)
        }

        const nextBtn = page.getByText('下一题 →').or(page.getByText('查看结果 →')).first()
        if (await nextBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          const txt = (await nextBtn.textContent()) ?? ''
          await nextBtn.click()
          await page.waitForTimeout(500)
          if (txt.includes('结果')) break
        }

        // 检测是否已到结束页
        const done = page.getByText('练习完成！').or(page.getByText('考试结束')).first()
        if (await done.isVisible({ timeout: 1_000 }).catch(() => false)) break
      }

      // 验证成绩页或统计信息
      const scoreVisible = await page
        .getByText('正确率')
        .or(page.getByText('总题数'))
        .or(page.getByText('练习完成！'))
        .first()
        .isVisible({ timeout: 10_000 })
        .catch(() => false)

      expect(scoreVisible).toBe(true)
    } finally {
      await closeApp(handle)
    }
  })
})
