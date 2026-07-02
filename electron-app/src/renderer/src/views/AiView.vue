<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAiStore, type GenerateParams } from '../stores/ai'
import { useQuestionStore } from '../stores/question'
import { toIpcPayload } from '../utils/ipc'

const ai = useAiStore()
const questionStore = useQuestionStore()

const activeTab = ref<'generate' | 'grade' | 'chat'>('generate')

// Chat tab
interface ChatMessage { role: 'user' | 'assistant'; content: string; sources?: { page_num: number; doc_title: string }[] }
const chatMessages = ref<ChatMessage[]>([])
const chatInput = ref('')
const chatLoading = ref(false)
const useDocContext = ref(true)
const chatError = ref('')

async function sendChat() {
  const q = chatInput.value.trim()
  if (!q || chatLoading.value) return
  chatInput.value = ''
  chatError.value = ''
  chatMessages.value.push({ role: 'user', content: q })
  chatLoading.value = true
  try {
    const res = await window.electronAPI.aiChat(toIpcPayload({ question: q, useDocContext: useDocContext.value }))
    if (res.success) {
      chatMessages.value.push({ role: 'assistant', content: res.data.answer, sources: res.data.sources as { page_num: number; doc_title: string }[] })
    } else {
      chatError.value = (res.error as { message: string }).message
    }
  } catch (e) {
    chatError.value = String(e)
  } finally {
    chatLoading.value = false
  }
}

// Generate tab
const genParams = ref<GenerateParams>({ count: 5, types: ['single'], knowledge_tags: [], difficulty: undefined })
const tagInput = ref('')
const genError = ref('')
const savingGenerated = ref(false)
const saveSuccess = ref('')

// Grade tab
const gradeQ = ref('')
const gradeRef = ref('')
const gradeAnswer = ref('')
const gradeError = ref('')

onMounted(() => ai.loadConfig())

function addGenTag() {
  const t = tagInput.value.trim()
  if (!t || genParams.value.knowledge_tags.includes(t)) return
  genParams.value.knowledge_tags.push(t)
  tagInput.value = ''
}
function removeGenTag(i: number) { genParams.value.knowledge_tags.splice(i, 1) }

async function doGenerate() {
  genError.value = ''; saveSuccess.value = ''
  try {
    await ai.generateQuestions(genParams.value)
  } catch (e) {
    genError.value = String(e)
  }
}

async function saveGenerated() {
  savingGenerated.value = true
  try {
    const count = await questionStore.batchImport(ai.generatedQuestions.map((q) => ({
      ...q,
      source_type: 'ai_generated',
    })))
    saveSuccess.value = `已保存 ${count} 道题到题库`
    ai.generatedQuestions = []
  } finally {
    savingGenerated.value = false
  }
}

async function doGrade() {
  gradeError.value = ''
  try {
    await ai.gradeEssay({ question: gradeQ.value, reference_points: gradeRef.value || undefined, user_answer: gradeAnswer.value })
  } catch (e) {
    gradeError.value = String(e)
  }
}

const typeLabels: Record<string, string> = { single: '单选', multiple: '多选', case: '案例', essay: '论文' }
</script>

<template>
  <div class="ai-view">
    <h2 class="view-title">AI 助手</h2>

    <div class="tabs">
      <button class="tab" :class="{ active: activeTab === 'generate' }" @click="activeTab = 'generate'">智能出题</button>
      <button class="tab" :class="{ active: activeTab === 'grade' }" @click="activeTab = 'grade'">AI 评分</button>
      <button class="tab" :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">AI 问答</button>
    </div>

    <!-- Generate Tab -->
    <div v-if="activeTab === 'generate'" class="tab-panel">
      <div class="gen-layout">
        <div class="gen-config">
          <h3 class="section-title">出题配置</h3>

          <div class="form-group">
            <label>题型</label>
            <div class="type-checks">
              <label v-for="t in [{label:'单选',value:'single'},{label:'多选',value:'multiple'},{label:'案例',value:'case'},{label:'论文',value:'essay'}]" :key="t.value" class="check-label">
                <input type="checkbox" :value="t.value" v-model="genParams.types" />
                {{ t.label }}
              </label>
            </div>
          </div>

          <div class="form-group">
            <label>数量</label>
            <input type="number" v-model.number="genParams.count" class="num-input" min="1" max="20" />
          </div>

          <div class="form-group">
            <label>难度（可选）</label>
            <select v-model="genParams.difficulty" class="select-sm">
              <option :value="undefined">不限</option>
              <option v-for="d in [1,2,3,4,5]" :key="d" :value="d">{{ d }} 级</option>
            </select>
          </div>

          <div class="form-group col">
            <label>知识点（可选）</label>
            <div class="tags-row">
              <span v-for="(tag, i) in genParams.knowledge_tags" :key="i" class="tag editable">
                {{ tag }}<button @click="removeGenTag(i)">✕</button>
              </span>
              <input v-model="tagInput" class="tag-input" placeholder="输入后回车" @keyup.enter="addGenTag" />
            </div>
          </div>

          <p v-if="genError" class="error-text">{{ genError }}</p>
          <button class="btn-primary gen-btn" @click="doGenerate" :disabled="ai.generating || !genParams.types.length">
            {{ ai.generating ? 'AI 出题中…' : '开始出题' }}
          </button>
        </div>

        <div class="gen-results">
          <div v-if="!ai.generatedQuestions.length && !ai.generating" class="empty-tip">
            <div style="font-size:36px;margin-bottom:8px">✦</div>
            <div>配置出题参数后点击「开始出题」</div>
          </div>
          <div v-else-if="ai.generating" class="empty-tip">
            <div class="spinner"></div>
            <div style="margin-top:12px">AI 正在生成题目…</div>
          </div>
          <template v-else>
            <div class="results-header">
              <span>共生成 {{ ai.generatedQuestions.length }} 道题</span>
              <div style="display:flex;gap:8px">
                <span v-if="saveSuccess" class="success-text">{{ saveSuccess }}</span>
                <button class="btn-sm btn-primary" @click="saveGenerated" :disabled="savingGenerated">
                  {{ savingGenerated ? '保存中…' : '全部保存到题库' }}
                </button>
              </div>
            </div>
            <div class="result-list">
              <div v-for="(q, i) in ai.generatedQuestions" :key="i" class="result-card">
                <div class="result-meta">
                  <span class="type-badge" :class="q.type">{{ typeLabels[q.type] }}</span>
                  <span class="diff-text">难度 {{ q.difficulty }}</span>
                  <span v-for="tag in (q.knowledge_tags ?? [])" :key="tag" class="tag">{{ tag }}</span>
                </div>
                <div class="result-content">{{ q.content }}</div>
                <div v-if="q.options?.length" class="result-options">
                  <div v-for="opt in q.options" :key="opt" class="result-opt">{{ opt }}</div>
                </div>
                <div v-if="q.answer" class="result-answer">答案：<strong>{{ q.answer }}</strong></div>
                <div v-if="q.explanation" class="result-exp">解析：{{ q.explanation }}</div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Grade Tab -->
    <div v-if="activeTab === 'grade'" class="tab-panel">
      <div class="grade-layout">
        <div class="grade-inputs">
          <h3 class="section-title">提交评分</h3>
          <div class="form-group col">
            <label>题目</label>
            <textarea v-model="gradeQ" class="textarea" rows="4" placeholder="粘贴论文/案例题目要求…"></textarea>
          </div>
          <div class="form-group col">
            <label>评分要点（可选）</label>
            <textarea v-model="gradeRef" class="textarea" rows="3" placeholder="参考答案要点…"></textarea>
          </div>
          <div class="form-group col">
            <label>考生答案</label>
            <textarea v-model="gradeAnswer" class="textarea" rows="8" placeholder="在此粘贴考生的论文或案例答案…"></textarea>
          </div>
          <p v-if="gradeError" class="error-text">{{ gradeError }}</p>
          <button class="btn-primary" @click="doGrade" :disabled="ai.grading || !gradeQ.trim() || !gradeAnswer.trim()">
            {{ ai.grading ? 'AI 评分中…' : '提交 AI 评分' }}
          </button>
        </div>

        <div class="grade-result">
          <div v-if="!ai.gradeResult && !ai.grading" class="empty-tip">
            <div style="font-size:36px;margin-bottom:8px">📝</div>
            <div>填写题目和答案后提交评分</div>
          </div>
          <div v-else-if="ai.grading" class="empty-tip">
            <div class="spinner"></div>
            <div style="margin-top:12px">AI 正在评分，请稍候…</div>
          </div>
          <template v-else-if="ai.gradeResult">
            <h3 class="section-title">评分结果</h3>
            <div class="score-total">
              <div class="score-num">{{ ai.gradeResult.total_score }}</div>
              <div class="score-label">总分</div>
            </div>
            <div class="dimension-list">
              <div v-for="dim in ai.gradeResult.dimension_scores" :key="dim.name" class="dimension-item">
                <div class="dim-header">
                  <span class="dim-name">{{ dim.name }}</span>
                  <span class="dim-score">{{ dim.score }} / {{ dim.max_score }}</span>
                </div>
                <div class="dim-bar-bg">
                  <div class="dim-bar" :style="{ width: (dim.score / dim.max_score * 100) + '%' }"></div>
                </div>
                <div class="dim-comment">{{ dim.comment }}</div>
              </div>
            </div>
            <div class="grade-feedback">
              <div class="section-title" style="margin-bottom:8px">整体评语</div>
              <div class="feedback-text">{{ ai.gradeResult.feedback }}</div>
            </div>
            <div v-if="ai.gradeResult.suggestions?.length" class="grade-suggestions">
              <div class="section-title" style="margin-bottom:8px">改进建议</div>
              <ul class="suggestion-list">
                <li v-for="s in ai.gradeResult.suggestions" :key="s">{{ s }}</li>
              </ul>
            </div>
          </template>
        </div>
      </div>
    </div>
    <!-- Chat Tab -->
    <div v-if="activeTab === 'chat'" class="tab-panel chat-panel-wrap">
      <div class="chat-toolbar">
        <label class="check-label">
          <input type="checkbox" v-model="useDocContext" />
          使用文档库作为参考资料（RAG）
        </label>
      </div>
      <div class="chat-messages">
        <div v-if="chatMessages.length === 0" class="chat-empty">
          <div style="font-size:36px;margin-bottom:8px">✦</div>
          <div>向 AI 提问软考架构相关问题</div>
          <div style="font-size:12px;margin-top:4px;color:var(--c-border-2)">勾选上方选项可引用已导入文档作为参考</div>
        </div>
        <template v-else>
          <div v-for="(msg, i) in chatMessages" :key="i" class="chat-msg" :class="msg.role">
            <div class="msg-bubble">
              <div class="msg-content">{{ msg.content }}</div>
              <div v-if="msg.sources && msg.sources.length" class="msg-sources">
                <span v-for="(s, j) in msg.sources" :key="j" class="source-chip">
                  📄 {{ s.doc_title }} p.{{ s.page_num }}
                </span>
              </div>
            </div>
          </div>
          <div v-if="chatLoading" class="chat-msg assistant">
            <div class="msg-bubble loading">
              <div class="spinner"></div>
            </div>
          </div>
        </template>
      </div>
      <div class="chat-input-row">
        <p v-if="chatError" class="error-text chat-error">{{ chatError }}</p>
        <div class="chat-input-wrap">
          <textarea
            v-model="chatInput"
            class="chat-input"
            rows="2"
            placeholder="按 Enter 发送，Shift+Enter 换行"
            @keydown.enter.exact.prevent="sendChat"
          ></textarea>
          <button class="send-btn" @click="sendChat" :disabled="chatLoading || !chatInput.trim()">
            {{ chatLoading ? '…' : '发送' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-view { display: flex; flex-direction: column; height: 100%; gap: 16px; overflow: hidden; }
.view-title { font-size: 20px; font-weight: 700; color: var(--c-text); }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--c-border); }
.tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 16px; font-size: 14px; color: var(--c-text-2); cursor: pointer; margin-bottom: -1px; }
.tab:hover { color: var(--c-text); }
.tab.active { color: var(--c-brand); border-bottom-color: var(--c-brand); }
.tab-panel { flex: 1; overflow: hidden; }

.gen-layout, .grade-layout { display: grid; grid-template-columns: 300px 1fr; gap: 16px; height: 100%; overflow: hidden; }

.gen-config, .grade-inputs { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }
.gen-results, .grade-result { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; overflow-y: auto; }
.section-title { font-size: 14px; font-weight: 600; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.05em; }
.form-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.form-group.col { flex-direction: column; align-items: flex-start; }
.form-group label { font-size: 13px; color: var(--c-text-2); min-width: 60px; }
.type-checks { display: flex; gap: 12px; flex-wrap: wrap; }
.check-label { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--c-text); cursor: pointer; }
.num-input { background: var(--c-bg); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 5px 8px; width: 60px; font-size: 13px; }
.select-sm { background: var(--c-bg); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 5px 8px; font-size: 13px; }
.tags-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; width: 100%; }
.tag { display: inline-block; background: #1e3a5f; color: #93c5fd; border-radius: 4px; padding: 1px 6px; font-size: 11px; }
.tag.editable button { background: none; border: none; color: #93c5fd; cursor: pointer; margin-left: 2px; }
.tag-input { background: var(--c-bg); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 4px 8px; font-size: 12px; width: 120px; }
.gen-btn { align-self: flex-start; }
.textarea { width: 100%; background: var(--c-bg); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 8px 10px; font-size: 13px; resize: vertical; font-family: inherit; }
.btn-primary { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { background: var(--c-border); border: none; border-radius: 6px; color: var(--c-text); padding: 6px 12px; font-size: 13px; cursor: pointer; }
.btn-sm:hover:not(:disabled) { background: var(--c-border-2); }
.error-text { color: #f87171; font-size: 13px; }
.success-text { color: #4ade80; font-size: 13px; align-self: center; }

.results-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--c-border); font-size: 13px; color: var(--c-text-2); position: sticky; top: 0; background: var(--c-panel); }
.result-list { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.result-card { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.result-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.type-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.type-badge.single { background: #1e3a5f; color: var(--c-brand); }
.type-badge.multiple { background: var(--c-ok-bg); color: #4ade80; }
.type-badge.case { background: var(--c-warn-bg); color: #fb923c; }
.type-badge.essay { background: #3b0764; color: #c084fc; }
.diff-text { font-size: 11px; color: var(--c-text-2); }
.result-content { font-size: 13px; color: var(--c-text); line-height: 1.6; }
.result-options { display: flex; flex-direction: column; gap: 4px; }
.result-opt { font-size: 12px; color: var(--c-text-2); padding: 2px 6px; border-left: 2px solid var(--c-border); }
.result-answer { font-size: 12px; color: var(--c-text-2); }
.result-answer strong { color: #4ade80; }
.result-exp { font-size: 12px; color: var(--c-text-3); }

/* Grade result */
.grade-result { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.score-total { text-align: center; }
.score-num { font-size: 64px; font-weight: 700; color: var(--c-brand); line-height: 1; }
.score-label { font-size: 14px; color: var(--c-text-2); margin-top: 4px; }
.dimension-list { display: flex; flex-direction: column; gap: 12px; }
.dimension-item { display: flex; flex-direction: column; gap: 4px; }
.dim-header { display: flex; justify-content: space-between; font-size: 13px; }
.dim-name { color: var(--c-text); }
.dim-score { color: var(--c-brand); font-weight: 600; }
.dim-bar-bg { height: 6px; background: var(--c-border); border-radius: 3px; overflow: hidden; }
.dim-bar { height: 100%; background: #1d4ed8; border-radius: 3px; transition: width 0.5s; }
.dim-comment { font-size: 12px; color: var(--c-text-3); }
.grade-feedback, .grade-suggestions { background: var(--c-bg); border-radius: 8px; padding: 12px; }
.feedback-text { font-size: 13px; color: #cbd5e1; line-height: 1.7; }
.suggestion-list { list-style: disc; padding-left: 16px; display: flex; flex-direction: column; gap: 6px; }
.suggestion-list li { font-size: 13px; color: var(--c-text-2); }

.empty-tip { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 200px; color: var(--c-border-2); font-size: 13px; }
.spinner { width: 32px; height: 32px; border: 3px solid var(--c-border); border-top-color: var(--c-brand); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Chat tab */
.chat-panel-wrap { display: flex; flex-direction: column; height: 100%; }
.chat-toolbar { padding: 8px 0; border-bottom: 1px solid var(--c-border); flex-shrink: 0; }
.chat-messages { flex: 1; overflow-y: auto; padding: 12px 0; display: flex; flex-direction: column; gap: 12px; }
.chat-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--c-border-2); font-size: 13px; }
.chat-msg { display: flex; }
.chat-msg.user { justify-content: flex-end; }
.chat-msg.assistant { justify-content: flex-start; }
.msg-bubble { max-width: 75%; background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; padding: 10px 14px; }
.chat-msg.user .msg-bubble { background: #1e3a5f; border-color: #1d4ed8; }
.msg-content { font-size: 13px; color: var(--c-text); line-height: 1.7; white-space: pre-wrap; }
.msg-sources { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.source-chip { font-size: 11px; background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 4px; padding: 2px 6px; color: var(--c-text-3); }
.msg-bubble.loading { display: flex; align-items: center; justify-content: center; padding: 12px 16px; }
.chat-input-row { flex-shrink: 0; border-top: 1px solid var(--c-border); padding-top: 10px; }
.chat-error { margin-bottom: 6px; }
.chat-input-wrap { display: flex; gap: 8px; align-items: flex-end; }
.chat-input { flex: 1; background: var(--c-panel); border: 1px solid var(--c-border-2); border-radius: 8px; color: var(--c-text); padding: 8px 12px; font-size: 13px; resize: none; font-family: inherit; }
.send-btn { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; flex-shrink: 0; }
.send-btn:hover:not(:disabled) { background: #2563eb; }
.send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
