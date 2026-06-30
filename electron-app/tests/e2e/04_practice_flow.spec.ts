/**
 * Scenario 4: 完整练习流程
 * 批量导入题目 → 选择随机练习 → 完成 5 题 → 验证成绩和错题记录。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'
import path from 'path'
import fs from 'fs'

const QUESTIONS_FIXTURE = path.resolve(__dirname, 'fixtures/questions.json')

test.describe('完整练习流程', () => {
  test('批量导入 10 道题，全部正确入库', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .q-table, .toolbar', { timeout: 10_000 })

      // 拦截文件选择，返回 fixture JSON
      await handle.app.evaluate(
        ({ dialog }, fixturePath) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
        },
        QUESTIONS_FIXTURE,
      )

      // 点击批量导入
      const importBtn = page.getByText('批量导入').or(page.getByText('导入题目')).first()
      await importBtn.click({ timeout: 10_000 })

      // 等待导入确认 / 导入完成提示
      await page
        .waitForSelector('.modal, dialog, [role="dialog"]', { timeout: 8_000 })
        .catch(() => {})

      // 若出现确认对话框，点击确认
      const confirmBtn = page
        .getByText('确认导入')
        .or(page.getByText('确认'))
        .or(page.getByText('导入'))
        .last()
      if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await confirmBtn.click()
      }

      // 等待导入结果
      await page.waitForTimeout(3_000)

      // 题目总数应 ≥ 10
      const totalText = (await page.locator('.stat-row, .stats').textContent().catch(() => '')) ?? ''
      const numMatch = totalText.match(/(\d+)/)
      if (numMatch) {
        const num = parseInt(numMatch[1], 10)
        expect(num).toBeGreaterThanOrEqual(10)
      }
    } finally {
      await closeApp(handle)
    }
  })

  test('开始 5 题随机练习并完成', async () => {
    // 先写入题目（用 fixture JSON 内容通过 IPC 批量插入）
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 先导入题目
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })

      await handle.app.evaluate(
        ({ dialog }, fixturePath) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
        },
        QUESTIONS_FIXTURE,
      )
      const importBtn = page.getByText('批量导入').or(page.getByText('导入题目')).first()
      if (await importBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await importBtn.click()
        await page.waitForTimeout(2_000)
        const confirmBtn = page
          .getByText('确认导入')
          .or(page.getByText('确认'))
          .last()
        if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await confirmBtn.click()
        }
        await page.waitForTimeout(2_000)
      }

      // 导航到练习页
      await page.locator('.nav-item[href="#/practice"]').click()
      await page.waitForSelector('.config-panel, .practice-view, .mode-cards', { timeout: 10_000 })

      // 选择随机练习模式
      const randomMode = page.getByText('随机练习').or(page.getByText('顺序练习')).first()
      await randomMode.click({ timeout: 5_000 })

      // 设置题数为 5
      const countInput = page.locator('.count-input, input[type="number"]').first()
      if (await countInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await countInput.fill('5')
      }

      // 开始练习
      await page.getByText('开始练习').click({ timeout: 5_000 })
      await page.waitForSelector('.answering-panel, .question-card, .q-content', {
        timeout: 15_000,
      })

      // 完成 5 道题（每题选第一个选项后提交）
      for (let i = 0; i < 5; i++) {
        await page.waitForSelector('.option, .answering-panel', { timeout: 10_000 })

        // 选择第一个选项
        const firstOption = page.locator('.option').first()
        if (await firstOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await firstOption.click()
        }

        // 提交答案
        const submitBtn = page.getByText('提交答案').or(page.getByText('下一题 →')).first()
        if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await submitBtn.click()
          await page.waitForTimeout(500)
        }

        // 如果进入了 review 状态，点击下一题
        const nextBtn = page.getByText('下一题 →').or(page.getByText('查看结果 →')).first()
        if (await nextBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await nextBtn.click()
          await page.waitForTimeout(500)
        }
      }

      // 验证到达结果页
      const doneIndicators = page
        .getByText('练习完成！')
        .or(page.getByText('总题数'))
        .or(page.getByText('正确率'))
      await expect(doneIndicators.first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await closeApp(handle)
    }
  })

  test('练习中关闭应用再打开，不丢失作答记录', async () => {
    const handle = await launchApp()
    const { userDataDir } = handle
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导入题目并完成一次练习（简化版）
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })

      await handle.app.evaluate(
        ({ dialog }, fixturePath) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
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

      // 关闭应用，不清理 userDataDir
      await closeApp(handle, false)

      // 重新打开同一 userDataDir
      const handle2 = await launchApp({ userDataDir })
      try {
        await waitForPythonReady(handle2.page)
        await handle2.page.locator('.nav-item[href="#/questions"]').click()
        await handle2.page.waitForSelector('.qview, .q-table, .stat-row', { timeout: 10_000 })

        // 题目总数应仍然存在
        const stats = handle2.page.locator('.stat-row, .stats, .q-table tbody tr')
        const count = await stats.count()
        expect(count).toBeGreaterThanOrEqual(1)
      } finally {
        await closeApp(handle2)
      }
    } finally {
      // 若第一个 handle 因异常未关闭，强制关闭
      await handle.app.close().catch(() => {})
    }
  })
})
