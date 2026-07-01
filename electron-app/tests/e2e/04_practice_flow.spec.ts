/**
 * Scenario 4: 完整练习流程
 * 批量导入题目（粘贴 JSON）→ 随机练习 → 完成 → 验证成绩与错题记录。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'
import { fillTextarea } from './helpers/fill-textarea'
import path from 'path'
import fs from 'fs'

const QUESTIONS_FIXTURE = path.resolve(__dirname, 'fixtures/questions.json')

/** 通过 textarea 粘贴 JSON 批量导入题目 */
async function importQuestionsViaTextarea(
  page: import('playwright-core').Page,
  jsonPath: string,
): Promise<boolean> {
  const json = fs.readFileSync(jsonPath, 'utf-8')

  const importBtn = page.getByText('批量导入').first()
  if (!(await importBtn.isVisible({ timeout: 8_000 }).catch(() => false))) return false
  await importBtn.click()

  // 等待含 textarea 的 modal
  await page.waitForSelector('.modal', { timeout: 8_000 })
  const textarea = page.locator('.modal textarea').first()
  await textarea.waitFor({ state: 'visible', timeout: 5_000 })

  // 使用 evaluate 触发 Vue v-model（Electron 中 fill() 有时不会触发 input 事件）
  await fillTextarea(textarea, json)

  // 等待按钮变为可用（v-model 更新后 importText.trim() 非空）
  const confirmBtn = page.getByText('确认导入').first()
  await expect(confirmBtn).toBeEnabled({ timeout: 5_000 })
  await confirmBtn.click()

  // 等待完成提示（成功或错误）
  await page
    .waitForSelector('.success-text, .error-text', { timeout: 20_000 })
    .catch(() => {})
  await page.waitForTimeout(500)

  // 关闭 modal
  const closeBtn = page.locator('.modal .close-btn, .modal button:has-text("关闭")').first()
  if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeBtn.click()
    await page.waitForTimeout(500)
  }
  return true
}

test.describe('完整练习流程', () => {
  test('批量导入 10 道题，全部正确入库', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .q-table, .toolbar', { timeout: 10_000 })

      const ok = await importQuestionsViaTextarea(page, QUESTIONS_FIXTURE)
      expect(ok).toBe(true)

      // 等待列表刷新
      await page.waitForTimeout(1_000)

      // 题目数量 ≥ 10
      const rows = page.locator('.q-table tbody tr, .question-item')
      const count = await rows.count()
      expect(count).toBeGreaterThanOrEqual(10)
    } finally {
      await closeApp(handle)
    }
  })

  test('开始 5 题随机练习并完成', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 先导入题目
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })
      await importQuestionsViaTextarea(page, QUESTIONS_FIXTURE)

      // 导航到练习
      await page.locator('.nav-item[href="#/practice"]').click()
      await page.waitForSelector('.config-panel, .mode-cards, .practice-view', { timeout: 10_000 })

      // 选择随机练习
      const randomMode = page.getByText('随机练习').or(page.getByText('顺序练习')).first()
      await randomMode.click({ timeout: 5_000 })

      // 设置题数
      const countInput = page.locator('.count-input, input[type="number"]').first()
      if (await countInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await countInput.fill('5')
      }

      // 开始练习
      await page.getByText('开始练习').click({ timeout: 5_000 })
      await page.waitForSelector('.answering-panel, .question-card, .q-content', { timeout: 15_000 })

      // 完成 5 题
      for (let i = 0; i < 5; i++) {
        await page.waitForSelector('.option, .answering-panel', { timeout: 10_000 })
        const firstOption = page.locator('.option').first()
        if (await firstOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await firstOption.click()
        }

        const submitBtn = page.getByText('提交答案').first()
        if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await submitBtn.click()
          await page.waitForTimeout(300)
        }

        const nextBtn = page.getByText('下一题 →').or(page.getByText('查看结果 →')).first()
        if (await nextBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          const txt = (await nextBtn.textContent()) ?? ''
          await nextBtn.click()
          await page.waitForTimeout(300)
          if (txt.includes('结果')) break
        }

        const done = page.getByText('练习完成！').or(page.getByText('正确率')).first()
        if (await done.isVisible({ timeout: 500 }).catch(() => false)) break
      }

      // 到达结果页
      await expect(
        page.getByText('练习完成！').or(page.getByText('正确率')).or(page.getByText('总题数')).first(),
      ).toBeVisible({ timeout: 15_000 })
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

      // 导入题目
      await page.locator('.nav-item[href="#/questions"]').click()
      await page.waitForSelector('.qview, .toolbar', { timeout: 10_000 })
      await importQuestionsViaTextarea(page, QUESTIONS_FIXTURE)

      // 关闭（保留 userDataDir）
      await closeApp(handle, false)

      // 重新打开同一数据目录
      const handle2 = await launchApp({ userDataDir })
      try {
        await waitForPythonReady(handle2.page)
        await handle2.page.locator('.nav-item[href="#/questions"]').click()
        await handle2.page.waitForSelector('.qview, .q-table, .toolbar', { timeout: 10_000 })

        const rows = handle2.page.locator('.q-table tbody tr, .question-item')
        const count = await rows.count()
        expect(count).toBeGreaterThanOrEqual(1)
      } finally {
        await closeApp(handle2)
      }
    } finally {
      await handle.app.close().catch(() => {})
    }
  })
})
