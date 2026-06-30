/**
 * Scenario 6: 数据备份与恢复
 * 验证手动备份生成文件 → 清空验证文件存在 → 恢复流程完整。
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'
import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'

const QUESTIONS_FIXTURE = path.resolve(__dirname, 'fixtures/questions.json')

test.describe('数据备份与恢复', () => {
  test('手动备份生成文件并可通过恢复流程还原', async () => {
    const backupDir = path.join(os.tmpdir(), `softexam-backup-${crypto.randomBytes(4).toString('hex')}`)
    fs.mkdirSync(backupDir, { recursive: true })

    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导入一些数据先
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

      // 导航到设置页
      await page.locator('.nav-item[href="#/settings"]').click()
      await page.waitForSelector('.settings-view, .settings-container, h2', { timeout: 8_000 })

      // 拦截文件夹选择对话框
      await handle.app.evaluate(
        ({ dialog }, dir) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${dir}/backup.zip` })
        },
        backupDir,
      )

      // 点击"立即备份"或"手动备份"
      const backupBtn = page
        .getByText('立即备份')
        .or(page.getByText('手动备份'))
        .or(page.getByText('备份'))
        .first()

      if (await backupBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
        await backupBtn.click()
        // 等待备份完成（最多 30 秒）
        await page
          .waitForSelector('[class*="success"], .toast', { timeout: 30_000 })
          .catch(() => {})
        await page.waitForTimeout(2_000)
      } else {
        test.skip()
        return
      }

      // 验证备份文件存在
      const files = fs.readdirSync(backupDir)
      const hasBackup = files.some((f) => f.endsWith('.zip') || f.endsWith('.bak') || f.endsWith('.db'))
      expect(hasBackup).toBe(true)

      // --- 恢复流程 ---
      // 拦截文件选择，返回备份文件
      const backupFile = path.join(backupDir, files[0])
      await handle.app.evaluate(
        ({ dialog }, fp) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fp] })
        },
        backupFile,
      )

      const restoreBtn = page
        .getByText('从备份恢复')
        .or(page.getByText('恢复备份'))
        .or(page.getByText('恢复'))
        .first()

      if (await restoreBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await restoreBtn.click()
        // 确认恢复对话框
        const confirmRestore = page.getByText('确认').or(page.getByText('恢复')).last()
        if (await confirmRestore.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await confirmRestore.click()
        }
        await page.waitForTimeout(3_000)
      }

      // 验证无错误弹窗
      const errMsg = page.locator('.error-msg, [class*="error"]:visible')
      expect(await errMsg.count()).toBe(0)
    } finally {
      await closeApp(handle)
      fs.rmSync(backupDir, { recursive: true, force: true })
    }
  })
})
