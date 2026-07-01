<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAiStore } from '../stores/ai'
import { useAppStore } from '../stores/app'
import type { BackupRecord } from '../../../preload/shared-types'
import { toIpcPayload } from '../utils/ipc'

const ai = useAiStore()
const appStore = useAppStore()

const apiKeyInput = ref('')
const anthropicKeyInput = ref('')
const saveMsg = ref('')
const saveErr = ref('')
const saving = ref(false)

const healthReminderMin = ref(45)
const healthEnabled = ref(true)

const backups = ref<BackupRecord[]>([])
const backupNote = ref('')
const backupBusy = ref(false)
const backupMsg = ref('')
const backupErr = ref('')

onMounted(async () => {
  await ai.loadConfig()
  apiKeyInput.value = ai.config.openai.apiKey || ''
  anthropicKeyInput.value = ai.config.anthropic.apiKey || ''

  const settings = await window.electronAPI.getSettings()
  if (settings.success) {
    const s = settings.data as Record<string, unknown>
    if (s['healthReminderMin']) healthReminderMin.value = s['healthReminderMin'] as number
    if (s['healthEnabled'] !== undefined) healthEnabled.value = s['healthEnabled'] as boolean
  }

  await loadBackups()
})

async function saveAi() {
  saveMsg.value = ''
  saveErr.value = ''
  saving.value = true
  try {
    await ai.saveConfig({
      mode: ai.config.mode,
      openai: { ...ai.config.openai, apiKey: apiKeyInput.value },
      ollama: { ...ai.config.ollama },
      anthropic: { ...ai.config.anthropic, apiKey: anthropicKeyInput.value },
    })
    saveMsg.value = '配置已保存'
  } catch (e) {
    saveErr.value = String(e)
  } finally {
    saving.value = false
  }
}

async function testConn() {
  await ai.testConnection({
    mode: ai.config.mode,
    openai: { ...ai.config.openai, apiKey: apiKeyInput.value },
    ollama: { ...ai.config.ollama },
    anthropic: { ...ai.config.anthropic, apiKey: anthropicKeyInput.value },
  })
}

async function saveHealthSettings() {
  await window.electronAPI.setSetting(toIpcPayload({ key: 'healthReminderMin', value: healthReminderMin.value }))
  await window.electronAPI.setSetting(toIpcPayload({ key: 'healthEnabled', value: healthEnabled.value }))
}

async function loadBackups() {
  const res = await window.electronAPI.listBackups()
  if (res.success) backups.value = (res.data as BackupRecord[]).slice(0, 10)
}

async function doBackup() {
  backupBusy.value = true
  backupMsg.value = ''
  backupErr.value = ''
  try {
    const res = await window.electronAPI.createBackup(toIpcPayload({ note: backupNote.value || '手动备份' }))
    if (res.success) {
      backupMsg.value = `备份成功：${(res.data as BackupRecord).file_path}`
      backupNote.value = ''
      await loadBackups()
    } else {
      backupErr.value = (res as { error: { message: string } }).error.message
    }
  } catch (e) {
    backupErr.value = String(e)
  } finally {
    backupBusy.value = false
  }
}

async function doRestore() {
  if (!confirm('恢复备份将替换当前所有数据，应用会自动重启。确认继续？')) return

  backupBusy.value = true
  backupMsg.value = ''
  backupErr.value = ''
  try {
    const res = await window.electronAPI.restoreBackup()
    if (res.success && (res.data as { restored: boolean }).restored) {
      backupMsg.value = '恢复成功，请重启应用'
    } else if (res.success) {
      backupMsg.value = '已取消'
    } else {
      backupErr.value = (res as { error: { message: string } }).error.message
    }
  } catch (e) {
    backupErr.value = String(e)
  } finally {
    backupBusy.value = false
  }
}

async function delBackup(id: string) {
  await window.electronAPI.deleteBackup(id)
  await loadBackups()
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDt(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="settings-view">
    <h2 class="page-title">设置</h2>

    <div class="section">
      <h3 class="section-title">外观</h3>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">深色模式</div>
          <div class="setting-desc">切换界面明暗主题</div>
        </div>
        <button class="toggle-btn" :class="{ on: appStore.darkMode }" @click="appStore.toggleDarkMode">
          <div class="toggle-thumb"></div>
        </button>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">AI 配置</h3>

      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">AI 服务商</div>
          <div class="setting-desc">选择 LLM 服务来源</div>
        </div>
        <div class="radio-group">
          <label class="radio-label">
            <input v-model="ai.config.mode" type="radio" value="openai" />
            OpenAI 兼容
          </label>
          <label class="radio-label">
            <input v-model="ai.config.mode" type="radio" value="anthropic" />
            Anthropic
          </label>
          <label class="radio-label">
            <input v-model="ai.config.mode" type="radio" value="ollama" />
            本地 Ollama
          </label>
        </div>
      </div>

      <div v-if="ai.config.mode === 'openai'" class="sub-section">
        <div class="form-row">
          <label>Base URL</label>
          <input v-model="ai.config.openai.baseUrl" class="text-input" placeholder="https://api.openai.com/v1" />
        </div>
        <div class="form-row">
          <label>API Key</label>
          <input v-model="apiKeyInput" class="text-input" type="password" placeholder="sk-…" autocomplete="off" />
        </div>
        <div class="form-row">
          <label>模型</label>
          <input v-model="ai.config.openai.model" class="text-input" placeholder="gpt-4o-mini" />
        </div>
      </div>

      <div v-if="ai.config.mode === 'anthropic'" class="sub-section">
        <div class="form-row">
          <label>API Key</label>
          <input v-model="anthropicKeyInput" class="text-input" type="password" placeholder="sk-ant-…" autocomplete="off" />
        </div>
        <div class="form-row">
          <label>模型</label>
          <input v-model="ai.config.anthropic.model" class="text-input" placeholder="claude-sonnet-4-6" />
        </div>
        <div class="form-hint">使用 Anthropic 官方 API（api.anthropic.com）</div>
      </div>

      <div v-if="ai.config.mode === 'ollama'" class="sub-section">
        <div class="form-row">
          <label>Base URL</label>
          <input v-model="ai.config.ollama.baseUrl" class="text-input" placeholder="http://localhost:11434" />
        </div>
        <div class="form-row">
          <label>模型</label>
          <input v-model="ai.config.ollama.model" class="text-input" placeholder="qwen2.5" />
        </div>
      </div>

      <div class="action-row">
        <button class="btn-outline" :disabled="ai.testingConnection" @click="testConn">
          {{ ai.testingConnection ? '测试中…' : '测试连接' }}
        </button>
        <span v-if="ai.connectionResult" :class="ai.connectionResult.ok ? 'success-text' : 'error-text'">
          {{ ai.connectionResult.ok ? `✓ 连接正常：${ai.connectionResult.reply}` : `✗ ${ai.connectionResult.reply}` }}
        </span>
      </div>

      <div class="action-row">
        <button class="btn-primary" :disabled="saving" @click="saveAi">
          {{ saving ? '保存中…' : '保存 AI 配置' }}
        </button>
        <span v-if="saveMsg" class="success-text">{{ saveMsg }}</span>
        <span v-if="saveErr" class="error-text">{{ saveErr }}</span>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">健康学习提醒</h3>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">启用提醒</div>
          <div class="setting-desc">连续学习超过指定时长后弹出提醒</div>
        </div>
        <button class="toggle-btn" :class="{ on: healthEnabled }" @click="healthEnabled = !healthEnabled; saveHealthSettings()">
          <div class="toggle-thumb"></div>
        </button>
      </div>
      <div v-if="healthEnabled" class="setting-row">
        <div class="setting-info">
          <div class="setting-name">提醒阈值</div>
          <div class="setting-desc">连续学习多少分钟后提醒</div>
        </div>
        <div class="radio-group">
          <label v-for="min in [30, 45, 60]" :key="min" class="radio-label">
            <input v-model="healthReminderMin" :value="min" type="radio" @change="saveHealthSettings" />
            {{ min }} 分钟
          </label>
        </div>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">数据备份与恢复</h3>

      <div class="backup-actions">
        <input
          v-model="backupNote"
          class="text-input backup-note"
          placeholder="备份备注（可选）"
        />
        <button class="btn-primary" :disabled="backupBusy" @click="doBackup">
          {{ backupBusy ? '处理中…' : '立即备份' }}
        </button>
        <button class="btn-outline" :disabled="backupBusy" @click="doRestore">
          从文件恢复
        </button>
      </div>

      <span v-if="backupMsg" class="success-text">{{ backupMsg }}</span>
      <span v-if="backupErr" class="error-text">{{ backupErr }}</span>

      <div v-if="backups.length > 0" class="backup-list">
        <div v-for="b in backups" :key="b.id" class="backup-item">
          <div class="backup-meta">
            <span class="backup-date">{{ formatDt(b.created_at) }}</span>
            <span class="backup-size">{{ formatBytes(b.size_bytes) }}</span>
            <span v-if="b.note" class="backup-note-badge">{{ b.note }}</span>
          </div>
          <div class="backup-path">{{ b.file_path }}</div>
          <button class="del-btn" title="删除此备份记录" @click="delBackup(b.id)">×</button>
        </div>
      </div>
      <div v-else class="info-row">
        <span class="info-val" style="color:var(--c-text-3)">暂无备份记录，首次启动 30 秒后会自动备份</span>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">数据库</h3>
      <div class="info-row">
        <span class="info-label">状态</span>
        <span :class="appStore.dbReady ? 'badge-ok' : 'badge-warn'">{{ appStore.dbReady ? '正常' : '未就绪' }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Schema 版本</span>
        <span class="info-val">v{{ appStore.dbVersion }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view { max-width: 680px; display: flex; flex-direction: column; gap: 24px; }
.page-title { font-size: 22px; font-weight: 700; color: var(--c-text); }
.section { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 16px; transition: background-color 0.2s, border-color 0.2s; }
.section-title { font-size: 12px; font-weight: 700; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.08em; }

.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.setting-info { display: flex; flex-direction: column; gap: 3px; }
.setting-name { font-size: 14px; color: var(--c-text); font-weight: 500; }
.setting-desc { font-size: 12px; color: var(--c-text-3); }

.toggle-btn { width: 48px; height: 26px; border-radius: 13px; background: var(--c-border-2); border: none; cursor: pointer; position: relative; transition: background 0.2s; flex-shrink: 0; }
.toggle-btn.on { background: #1d4ed8; }
.toggle-thumb { width: 20px; height: 20px; border-radius: 50%; background: #fff; position: absolute; top: 3px; left: 3px; transition: left 0.2s; }
.toggle-btn.on .toggle-thumb { left: 25px; }

.radio-group { display: flex; gap: 16px; }
.radio-label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text); cursor: pointer; }

.sub-section { background: var(--c-bg); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px; transition: background-color 0.2s; }
.form-row { display: flex; align-items: center; gap: 10px; }
.form-row label { min-width: 70px; font-size: 13px; color: var(--c-text-2); flex-shrink: 0; }
.text-input { flex: 1; background: var(--c-input); border: 1px solid var(--c-input-border); border-radius: 6px; color: var(--c-text); padding: 7px 10px; font-size: 13px; transition: background-color 0.2s, border-color 0.2s, color 0.2s; }
.text-input:focus { outline: none; border-color: var(--c-brand); }

.form-hint { font-size: 11px; color: var(--c-text-3); padding-top: 2px; }
.action-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.btn-primary { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 18px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-outline { background: none; border: 1px solid var(--c-border-2); border-radius: 8px; color: var(--c-text-2); padding: 8px 18px; font-size: 14px; cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.btn-outline:hover:not(:disabled) { border-color: var(--c-text-2); color: var(--c-text); }
.btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }

.success-text { color: #4ade80; font-size: 13px; }
.error-text { color: #f87171; font-size: 13px; }

.info-row { display: flex; align-items: center; gap: 12px; }
.info-label { font-size: 13px; color: var(--c-text-3); min-width: 80px; }
.info-val { font-size: 13px; color: var(--c-text); }
.badge-ok { background: var(--c-ok-bg); color: var(--c-ok-text); border-radius: 4px; padding: 2px 8px; font-size: 12px; }
.badge-warn { background: var(--c-warn-bg); color: var(--c-warn-text); border-radius: 4px; padding: 2px 8px; font-size: 12px; }

.backup-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.backup-note { flex: 1; min-width: 160px; }
.backup-list { display: flex; flex-direction: column; gap: 6px; }
.backup-item {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 4px 8px;
  align-items: center;
  transition: background-color 0.2s, border-color 0.2s;
}
.backup-meta { display: flex; align-items: center; gap: 10px; }
.backup-date { font-size: 13px; color: var(--c-text); }
.backup-size { font-size: 11px; color: var(--c-text-3); }
.backup-note-badge { font-size: 10px; background: var(--c-tag-bg); color: var(--c-tag-text); border-radius: 4px; padding: 1px 6px; }
.backup-path { font-size: 10px; color: var(--c-border-2); grid-column: 1; word-break: break-all; }
.del-btn {
  grid-column: 2;
  grid-row: 1 / 3;
  align-self: center;
  background: none;
  border: none;
  color: var(--c-border-2);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
}
.del-btn:hover { color: #f87171; }
</style>
