<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAiStore } from '../stores/ai'
import { useAppStore } from '../stores/app'
import type { BackupRecord, StoragePathsInfo, StoragePathsUpdateResult } from '../../../preload/shared-types'
import { toIpcPayload } from '../utils/ipc'

const ai = useAiStore()
const appStore = useAppStore()

const apiKeyInput = ref('')
const anthropicKeyInput = ref('')
const showOpenAiKey = ref(false)
const showAnthropicKey = ref(false)
const saveMsg = ref('')
const saveErr = ref('')
const saving = ref(false)

const healthReminderMin = ref(45)
const healthEnabled = ref(true)

const storagePaths = ref<StoragePathsInfo | null>(null)
const dataRootInput = ref('')
const pathSaving = ref(false)
const pathMsg = ref('')
const pathErr = ref('')
const restartNeeded = ref(false)

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

  await loadStoragePaths()
  await loadBackups()
})

async function loadStoragePaths() {
  const res = await window.electronAPI.getStoragePaths()
  if (!res.success) return
  storagePaths.value = res.data
  dataRootInput.value = res.data.customDataRootDir
}

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
    saveMsg.value = 'AI 配置已保存'
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

async function pickDataRootDirectory() {
  const res = await window.electronAPI.pickDirectory(
    toIpcPayload({
      title: '选择数据根目录',
      defaultPath: dataRootInput.value || storagePaths.value?.dataRootDir,
    }),
  )
  if (res.success && res.data) dataRootInput.value = res.data
}

async function saveStorage() {
  pathMsg.value = ''
  pathErr.value = ''
  pathSaving.value = true
  restartNeeded.value = false

  const confirmed = confirm('应用会复制当前数据库、配置和托管文档到新的数据根目录。保存后需要重启应用，是否继续？')
  if (!confirmed) {
    pathSaving.value = false
    return
  }

  try {
    const res = await window.electronAPI.setStoragePaths(
      toIpcPayload({ dataRootDir: dataRootInput.value.trim() || undefined }),
    )
    if (!res.success) {
      pathErr.value = res.error.message
      return
    }

    const payload = res.data as StoragePathsUpdateResult
    storagePaths.value = payload.paths
    dataRootInput.value = payload.paths.customDataRootDir
    restartNeeded.value = payload.restartRequired
    pathMsg.value = payload.restartRequired ? '路径已更新，重启后切换到新位置。' : '路径已更新。'
  } catch (e) {
    pathErr.value = String(e)
  } finally {
    pathSaving.value = false
  }
}

async function relaunchApp() {
  await window.electronAPI.relaunchApp()
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
      backupErr.value = res.error.message
    }
  } catch (e) {
    backupErr.value = String(e)
  } finally {
    backupBusy.value = false
  }
}

async function doRestore() {
  if (!confirm('恢复备份会覆盖当前数据库内容，是否继续？')) return

  backupBusy.value = true
  backupMsg.value = ''
  backupErr.value = ''
  try {
    const res = await window.electronAPI.restoreBackup()
    if (res.success && res.data.restored) {
      backupMsg.value = '恢复成功，请重启应用确认结果。'
    } else if (res.success) {
      backupMsg.value = '已取消恢复。'
    } else {
      backupErr.value = res.error.message
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
          <div class="setting-desc">切换应用主题外观。</div>
        </div>
        <button class="toggle-btn" :class="{ on: appStore.darkMode }" @click="appStore.toggleDarkMode">
          <div class="toggle-thumb"></div>
        </button>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">数据路径</h3>
      <div class="setting-info">
        <div class="setting-name">修改数据根目录</div>
        <div class="setting-desc">数据库、AI 配置、应用设置、备份目录和文档库都会跟随这个目录一起迁移。文档库固定为数据根目录下的 `documents`。</div>
      </div>

      <div class="sub-section">
        <div class="form-block">
          <label>数据根目录</label>
          <div class="path-input-row">
            <input v-model="dataRootInput" class="text-input" :placeholder="storagePaths?.defaultDataRootDir || '使用默认目录'" />
            <button class="btn-outline compact-btn" type="button" @click="pickDataRootDirectory">浏览</button>
            <button class="btn-outline compact-btn" type="button" @click="dataRootInput = ''">默认</button>
          </div>
          <div class="form-hint">留空时使用默认 `userData` 目录。</div>
        </div>
      </div>

      <div v-if="storagePaths" class="path-grid">
        <div class="path-item">
          <span class="path-label">当前数据根目录</span>
          <span class="path-value">{{ storagePaths.dataRootDir }}</span>
        </div>
        <div class="path-item">
          <span class="path-label">当前数据库</span>
          <span class="path-value">{{ storagePaths.databasePath }}</span>
        </div>
        <div class="path-item">
          <span class="path-label">当前 AI 配置</span>
          <span class="path-value">{{ storagePaths.aiConfigPath }}</span>
        </div>
        <div class="path-item">
          <span class="path-label">当前应用设置</span>
          <span class="path-value">{{ storagePaths.appSettingsPath }}</span>
        </div>
        <div class="path-item">
          <span class="path-label">当前文档库</span>
          <span class="path-value">{{ storagePaths.documentLibraryDir }}</span>
        </div>
        <div class="path-item">
          <span class="path-label">默认备份目录</span>
          <span class="path-value">{{ storagePaths.backupDir }}</span>
        </div>
        <div class="path-item">
          <span class="path-label">启动路径配置</span>
          <span class="path-value">{{ storagePaths.bootstrapConfigPath }}</span>
        </div>
      </div>

      <div class="action-row">
        <button class="btn-primary" :disabled="pathSaving" @click="saveStorage">
          {{ pathSaving ? '保存中...' : '保存路径设置' }}
        </button>
        <button v-if="restartNeeded" class="btn-outline" type="button" @click="relaunchApp">立即重启</button>
        <span v-if="pathMsg" class="success-text">{{ pathMsg }}</span>
        <span v-if="pathErr" class="error-text">{{ pathErr }}</span>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">AI 配置</h3>

      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">AI 服务来源</div>
          <div class="setting-desc">选择当前使用的模型服务。</div>
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
          <div class="secret-input-row">
            <input
              v-model="apiKeyInput"
              class="text-input"
              :type="showOpenAiKey ? 'text' : 'password'"
              placeholder="sk-..."
              autocomplete="off"
            />
            <button class="btn-outline secret-toggle" type="button" @click="showOpenAiKey = !showOpenAiKey">
              {{ showOpenAiKey ? '隐藏' : '显示' }}
            </button>
          </div>
        </div>
        <div class="form-row">
          <label>Model</label>
          <input v-model="ai.config.openai.model" class="text-input" placeholder="gpt-4o-mini" />
        </div>
      </div>

      <div v-if="ai.config.mode === 'anthropic'" class="sub-section">
        <div class="form-row">
          <label>API Key</label>
          <div class="secret-input-row">
            <input
              v-model="anthropicKeyInput"
              class="text-input"
              :type="showAnthropicKey ? 'text' : 'password'"
              placeholder="sk-ant-..."
              autocomplete="off"
            />
            <button class="btn-outline secret-toggle" type="button" @click="showAnthropicKey = !showAnthropicKey">
              {{ showAnthropicKey ? '隐藏' : '显示' }}
            </button>
          </div>
        </div>
        <div class="form-row">
          <label>Model</label>
          <input v-model="ai.config.anthropic.model" class="text-input" placeholder="claude-sonnet-4-6" />
        </div>
        <div class="form-hint">Anthropic 使用官方接口 `api.anthropic.com`。</div>
      </div>

      <div v-if="ai.config.mode === 'ollama'" class="sub-section">
        <div class="form-row">
          <label>Base URL</label>
          <input v-model="ai.config.ollama.baseUrl" class="text-input" placeholder="http://localhost:11434" />
        </div>
        <div class="form-row">
          <label>Model</label>
          <input v-model="ai.config.ollama.model" class="text-input" placeholder="qwen2.5" />
        </div>
      </div>

      <div class="action-row">
        <button class="btn-outline" :disabled="ai.testingConnection" @click="testConn">
          {{ ai.testingConnection ? '测试中...' : '测试连接' }}
        </button>
        <span v-if="ai.connectionResult" :class="ai.connectionResult.ok ? 'success-text' : 'error-text'">
          {{ ai.connectionResult.reply }}
        </span>
      </div>

      <div class="action-row">
        <button class="btn-primary" :disabled="saving" @click="saveAi">
          {{ saving ? '保存中...' : '保存 AI 配置' }}
        </button>
        <span v-if="saveMsg" class="success-text">{{ saveMsg }}</span>
        <span v-if="saveErr" class="error-text">{{ saveErr }}</span>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">健康提醒</h3>
      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">启用提醒</div>
          <div class="setting-desc">连续学习达到阈值后弹出休息提醒。</div>
        </div>
        <button class="toggle-btn" :class="{ on: healthEnabled }" @click="healthEnabled = !healthEnabled; saveHealthSettings()">
          <div class="toggle-thumb"></div>
        </button>
      </div>
      <div v-if="healthEnabled" class="setting-row">
        <div class="setting-info">
          <div class="setting-name">提醒阈值</div>
          <div class="setting-desc">连续学习多久后提醒。</div>
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
      <h3 class="section-title">备份与恢复</h3>

      <div class="backup-actions">
        <input v-model="backupNote" class="text-input backup-note" placeholder="备份备注（可选）" />
        <button class="btn-primary" :disabled="backupBusy" @click="doBackup">
          {{ backupBusy ? '处理中...' : '立即备份' }}
        </button>
        <button class="btn-outline" :disabled="backupBusy" @click="doRestore">从文件恢复</button>
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
          <button class="del-btn" title="删除备份记录" @click="delBackup(b.id)">×</button>
        </div>
      </div>
      <div v-else class="info-row">
        <span class="info-val muted-text">暂无备份记录。</span>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">数据库</h3>
      <div class="info-row">
        <span class="info-label">状态</span>
        <span :class="appStore.dbReady ? 'badge-ok' : 'badge-warn'">{{ appStore.dbReady ? '正常' : '未就绪' }}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Schema</span>
        <span class="info-val">v{{ appStore.dbVersion }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-view { max-width: 760px; display: flex; flex-direction: column; gap: 24px; }
.page-title { font-size: 22px; font-weight: 700; color: var(--c-text); }
.section { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 16px; transition: background-color 0.2s, border-color 0.2s; }
.section-title { font-size: 12px; font-weight: 700; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.08em; }

.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.setting-info { display: flex; flex-direction: column; gap: 3px; }
.setting-name { font-size: 14px; color: var(--c-text); font-weight: 500; }
.setting-desc { font-size: 12px; color: var(--c-text-3); line-height: 1.5; }

.toggle-btn { width: 48px; height: 26px; border-radius: 13px; background: var(--c-border-2); border: none; cursor: pointer; position: relative; transition: background 0.2s; flex-shrink: 0; }
.toggle-btn.on { background: #1d4ed8; }
.toggle-thumb { width: 20px; height: 20px; border-radius: 50%; background: #fff; position: absolute; top: 3px; left: 3px; transition: left 0.2s; }
.toggle-btn.on .toggle-thumb { left: 25px; }

.radio-group { display: flex; gap: 16px; flex-wrap: wrap; }
.radio-label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text); cursor: pointer; }

.sub-section { background: var(--c-bg); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 12px; transition: background-color 0.2s; }
.form-row { display: flex; align-items: center; gap: 10px; }
.form-row label { min-width: 70px; font-size: 13px; color: var(--c-text-2); flex-shrink: 0; }
.form-block { display: flex; flex-direction: column; gap: 8px; }
.form-block label { font-size: 13px; color: var(--c-text-2); }
.secret-input-row,
.path-input-row { display: flex; align-items: center; gap: 8px; flex: 1; }
.text-input { flex: 1; background: var(--c-input); border: 1px solid var(--c-input-border); border-radius: 6px; color: var(--c-text); padding: 7px 10px; font-size: 13px; transition: background-color 0.2s, border-color 0.2s, color 0.2s; }
.text-input:focus { outline: none; border-color: var(--c-brand); }
.secret-toggle,
.compact-btn { padding: 7px 12px; flex-shrink: 0; }

.form-hint { font-size: 11px; color: var(--c-text-3); line-height: 1.5; }
.action-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.btn-primary { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 18px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-outline { background: none; border: 1px solid var(--c-border-2); border-radius: 8px; color: var(--c-text-2); padding: 8px 18px; font-size: 14px; cursor: pointer; transition: border-color 0.15s, color 0.15s; }
.btn-outline:hover:not(:disabled) { border-color: var(--c-text-2); color: var(--c-text); }
.btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }

.success-text { color: #4ade80; font-size: 13px; }
.error-text { color: #f87171; font-size: 13px; }
.muted-text { color: var(--c-text-3); }

.info-row { display: flex; align-items: center; gap: 12px; }
.info-label { font-size: 13px; color: var(--c-text-3); min-width: 80px; }
.info-val { font-size: 13px; color: var(--c-text); }
.badge-ok { background: var(--c-ok-bg); color: var(--c-ok-text); border-radius: 4px; padding: 2px 8px; font-size: 12px; }
.badge-warn { background: var(--c-warn-bg); color: var(--c-warn-text); border-radius: 4px; padding: 2px 8px; font-size: 12px; }

.path-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
.path-item { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.path-label { font-size: 11px; color: var(--c-text-3); text-transform: uppercase; letter-spacing: 0.05em; }
.path-value { font-size: 12px; color: var(--c-text); word-break: break-all; line-height: 1.5; }

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
.backup-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
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
  font-size: 16px;
  padding: 4px 8px;
}
.del-btn:hover { color: #f87171; }

@media (max-width: 720px) {
  .setting-row,
  .form-row,
  .path-input-row,
  .secret-input-row { align-items: stretch; flex-direction: column; }

  .form-row label { min-width: 0; }
}
</style>
