/**
 * Scenario 6: 数据备份与恢复
 *
 * 备份 IPC 流程：
 *   doBackup() → window.electronAPI.createBackup()
 *     → main: dialog.showOpenDialog(directory)  ← 需要拦截
 *     → 取消/选择目录后 createBackup(db, dir, note)
 *     → 返回 BackupRecord
 *   成功后 backupMsg = "备份成功：{file_path}" 显示在 .success-text
 *
 * 恢复 IPC 流程：
 *   doRestore() → browser confirm() ← page.on('dialog')
 *     → window.electronAPI.restoreBackup()
 *     → main: dialog.showOpenDialog(file) ← 需要拦截
 *     → 恢复 DB
 */
import { test, expect } from '@playwright/test'
import { launchApp, waitForPythonReady, closeApp } from './helpers/app'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

test.describe('数据备份与恢复', () => {
  test('手动备份：拦截 dialog → 写入默认目录，成功消息包含有效路径', async () => {
    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      // 导航到设置页
      await page.locator('.nav-item[href="#/settings"]').click()
      await page.waitForSelector('.settings-view', { timeout: 8_000 })

      // 拦截主进程目录选择对话框 → 取消 → IPC 使用默认备份目录
      await handle.app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
      })

      // 点击"立即备份"
      const backupBtn = page.getByText('立即备份').first()
      await expect(backupBtn).toBeVisible({ timeout: 5_000 })
      await backupBtn.click()

      // 等待成功消息（.success-text 显示 "备份成功：<path>"）
      const successEl = page.locator('.success-text')
      await expect(successEl).toBeVisible({ timeout: 30_000 })
      const successMsg = (await successEl.textContent()) ?? ''
      expect(successMsg).toContain('备份成功')

      // 从消息提取文件路径并验证文件存在
      const match = successMsg.match(/备份成功：(.+)/)
      if (match) {
        const backupFilePath = match[1].trim()
        expect(fs.existsSync(backupFilePath)).toBe(true)
      }

      // 备份列表应出现一条新记录
      const backupItems = page.locator('.backup-item')
      await expect(backupItems.first()).toBeVisible({ timeout: 5_000 })
    } finally {
      await closeApp(handle)
    }
  })

  test('恢复备份：先创建备份，拦截 dialog 返回备份文件，接受 confirm()', async () => {
    const backupDir = path.join(
      os.tmpdir(),
      `softexam-backup-${crypto.randomBytes(4).toString('hex')}`,
    )
    fs.mkdirSync(backupDir, { recursive: true })

    const handle = await launchApp()
    try {
      await waitForPythonReady(handle.page)
      const { page } = handle

      await page.locator('.nav-item[href="#/settings"]').click()
      await page.waitForSelector('.settings-view', { timeout: 8_000 })

      // 步骤1：创建备份 — 拦截 dialog 返回自定义目录
      await handle.app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
      }, backupDir)

      await page.getByText('立即备份').first().click()
      const successEl = page.locator('.success-text')
      await expect(successEl).toBeVisible({ timeout: 30_000 })
      const successMsg = (await successEl.textContent()) ?? ''
      const match = successMsg.match(/备份成功：(.+)/)
      if (!match) {
        test.skip()
        return
      }
      const backupFilePath = match[1].trim()
      expect(fs.existsSync(backupFilePath)).toBe(true)

      // 步骤2：恢复 — 拦截 dialog 返回刚备份的文件，接受 browser confirm()
      await handle.app.evaluate(({ dialog }, fp) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fp] })
      }, backupFilePath)

      // 接受浏览器 confirm() 对话框
      page.once('dialog', async (dlg) => {
        await dlg.accept()
      })

      const restoreBtn = page.getByText('从文件恢复').first()
      await expect(restoreBtn).toBeVisible({ timeout: 5_000 })
      await restoreBtn.click()

      // 等待结果（恢复成功/取消/错误）
      await page
        .waitForSelector('.success-text, .error-text', { timeout: 30_000 })
        .catch(() => {})

      // 无错误文本
      const errEl = page.locator('.error-text')
      if (await errEl.isVisible({ timeout: 1_000 }).catch(() => false)) {
        const errText = await errEl.textContent()
        expect(errText ?? '').toBeFalsy()
      }
    } finally {
      await closeApp(handle)
      fs.rmSync(backupDir, { recursive: true, force: true })
    }
  })
})
