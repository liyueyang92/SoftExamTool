<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAiStore } from '../stores/ai'
import { useAppStore } from '../stores/app'

const ai = useAiStore()
const appStore = useAppStore()

const apiKeyInput = ref('')
const saveMsg = ref('')
const saveErr = ref('')
const saving = ref(false)

onMounted(async () => {
  await ai.loadConfig()
  apiKeyInput.value = ai.config.openai.apiKey || ''
})

async function saveAi() {
  saveMsg.value = ''; saveErr.value = ''
  saving.value = true
  try {
    await ai.saveConfig({
      mode: ai.config.mode,
      openai: { ...ai.config.openai, apiKey: apiKeyInput.value },
      ollama: ai.config.ollama,
    })
    saveMsg.value = '配置已保存'
  } catch (e) {
    saveErr.value = String(e)
  } finally {
    saving.value = false
  }
}

async function testConn() {
  await ai.testConnection()
}
</script>

<template>
  <div class="settings-view">
    <h2 class="page-title">设置</h2>

    <!-- Appearance -->
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

    <!-- AI Config -->
    <div class="section">
      <h3 class="section-title">AI 配置</h3>

      <div class="setting-row">
        <div class="setting-info">
          <div class="setting-name">AI 模式</div>
          <div class="setting-desc">选择使用远程 API 还是本地 Ollama</div>
        </div>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" v-model="ai.config.mode" value="openai" />
            远程 API
          </label>
          <label class="radio-label">
            <input type="radio" v-model="ai.config.mode" value="ollama" />
            本地 Ollama
          </label>
        </div>
      </div>

      <!-- OpenAI-compatible config -->
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

      <!-- Ollama config -->
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
        <button class="btn-outline" @click="testConn" :disabled="ai.testingConnection">
          {{ ai.testingConnection ? '测试中…' : '测试连接' }}
        </button>
        <span v-if="ai.connectionResult" :class="ai.connectionResult.ok ? 'success-text' : 'error-text'">
          {{ ai.connectionResult.ok ? `✓ 连接正常：${ai.connectionResult.reply}` : `✗ ${ai.connectionResult.reply}` }}
        </span>
      </div>

      <div class="action-row">
        <button class="btn-primary" @click="saveAi" :disabled="saving">
          {{ saving ? '保存中…' : '保存 AI 配置' }}
        </button>
        <span v-if="saveMsg" class="success-text">{{ saveMsg }}</span>
        <span v-if="saveErr" class="error-text">{{ saveErr }}</span>
      </div>
    </div>

    <!-- DB info -->
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
.page-title { font-size: 22px; font-weight: 700; color: #e2e8f0; }
.section { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.section-title { font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; }

.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.setting-info { display: flex; flex-direction: column; gap: 3px; }
.setting-name { font-size: 14px; color: #e2e8f0; font-weight: 500; }
.setting-desc { font-size: 12px; color: #64748b; }

.toggle-btn { width: 48px; height: 26px; border-radius: 13px; background: #334155; border: none; cursor: pointer; position: relative; transition: background 0.2s; flex-shrink: 0; }
.toggle-btn.on { background: #1d4ed8; }
.toggle-thumb { width: 20px; height: 20px; border-radius: 50%; background: #fff; position: absolute; top: 3px; left: 3px; transition: left 0.2s; }
.toggle-btn.on .toggle-thumb { left: 25px; }

.radio-group { display: flex; gap: 16px; }
.radio-label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #e2e8f0; cursor: pointer; }

.sub-section { background: #0f172a; border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.form-row { display: flex; align-items: center; gap: 10px; }
.form-row label { min-width: 70px; font-size: 13px; color: #94a3b8; flex-shrink: 0; }
.text-input { flex: 1; background: #1e293b; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0; padding: 7px 10px; font-size: 13px; }
.text-input:focus { outline: none; border-color: #60a5fa; }

.action-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.btn-primary { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 18px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-outline { background: none; border: 1px solid #475569; border-radius: 8px; color: #94a3b8; padding: 8px 18px; font-size: 14px; cursor: pointer; }
.btn-outline:hover:not(:disabled) { border-color: #94a3b8; color: #e2e8f0; }
.btn-outline:disabled { opacity: 0.5; cursor: not-allowed; }

.success-text { color: #4ade80; font-size: 13px; }
.error-text { color: #f87171; font-size: 13px; }

.info-row { display: flex; align-items: center; gap: 12px; }
.info-label { font-size: 13px; color: #64748b; min-width: 80px; }
.info-val { font-size: 13px; color: #e2e8f0; }
.badge-ok { background: #14532d; color: #4ade80; border-radius: 4px; padding: 2px 8px; font-size: 12px; }
.badge-warn { background: #451a03; color: #f59e0b; border-radius: 4px; padding: 2px 8px; font-size: 12px; }
</style>
