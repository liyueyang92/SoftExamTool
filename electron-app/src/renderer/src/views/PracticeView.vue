<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { usePracticeStore, type PracticeConfig } from '../stores/practice'
import { useQuestionStore } from '../stores/question'

const store = usePracticeStore()
const questionStore = useQuestionStore()

const config = ref<PracticeConfig>({ mode: 'random', count: 20 })
const chosenTypes = ref<string[]>(['single'])
const essayAnswer = ref('')
const startError = ref('')
const starting = ref(false)

onMounted(async () => {
  await questionStore.fetchGroups()
})

async function startSession() {
  startError.value = ''
  starting.value = true
  try {
    await store.start({ ...config.value, filterTypes: chosenTypes.value })
  } catch (e) {
    startError.value = String(e)
  } finally {
    starting.value = false
  }
}

const chosenAnswer = ref('')
const submitted = ref(false)

async function submitCurrent() {
  if (submitted.value) return
  const answer = store.currentQuestion?.type === 'essay' ? essayAnswer.value : chosenAnswer.value
  if (!answer.trim()) return
  submitted.value = true
  await store.submitAnswer(answer)
}

function next() {
  store.continueNext()
  chosenAnswer.value = ''
  essayAnswer.value = ''
  submitted.value = false
}

async function finishSession() {
  await store.end()
}

function restart() { store.reset() }

const correctCount = computed(() => Object.values(store.answers).filter((a) => a.isCorrect).length)
const accuracy = computed(() => store.questions.length ? Math.round(correctCount.value / store.questions.length * 100) : 0)
const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F']
const recentExamYears = computed(() => {
  const year = new Date().getFullYear()
  return Array.from({ length: 5 }, (_, i) => year - i)
})

function isMultipleSelected(letter: string): boolean {
  return chosenAnswer.value.split(',').map((s) => s.trim()).includes(letter)
}
function toggleMultiple(letter: string) {
  const parts = chosenAnswer.value ? chosenAnswer.value.split(',').map((s) => s.trim()).filter(Boolean) : []
  const idx = parts.indexOf(letter)
  if (idx >= 0) parts.splice(idx, 1)
  else parts.push(letter)
  parts.sort()
  chosenAnswer.value = parts.join(',')
}
</script>

<template>
  <div class="practice-view">
    <!-- Config Phase -->
    <div v-if="store.phase === 'config'" class="config-panel">
      <h2>练习配置</h2>

      <div class="config-section">
        <label class="section-label">练习模式</label>
        <div class="mode-cards">
          <div v-for="m in [{value:'random',label:'随机练习',desc:'从全库随机抽题'},{value:'sequential',label:'顺序练习',desc:'按录入顺序练习'},{value:'wrong',label:'错题重做',desc:'专注错误题目'},{value:'favorites',label:'收藏专项',desc:'仅练习收藏题目'}]"
               :key="m.value"
               class="mode-card" :class="{ active: config.mode === m.value }"
               @click="config.mode = m.value as PracticeConfig['mode']">
            <div class="mode-name">{{ m.label }}</div>
            <div class="mode-desc">{{ m.desc }}</div>
          </div>
        </div>
      </div>

      <div class="config-section">
        <label class="section-label">题型筛选（可多选）</label>
        <div class="type-checks">
          <label v-for="t in [{label:'单选题',value:'single'},{label:'多选题',value:'multiple'},{label:'案例分析',value:'case'},{label:'论文题',value:'essay'}]" :key="t.value" class="check-label">
            <input type="checkbox" :value="t.value" v-model="chosenTypes" />
            {{ t.label }}
          </label>
        </div>
      </div>

      <div class="config-section">
        <label class="section-label">题库分组与来源筛选</label>
        <div class="type-checks">
          <select v-model="config.groupId" class="count-input group-filter" style="width:220px;text-align:left">
            <option :value="undefined">全部分组</option>
            <option v-for="g in questionStore.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <select v-model="config.sourceType" class="count-input" style="width:140px;text-align:left">
            <option :value="undefined">全部来源</option>
            <option value="manual">手动录入</option>
            <option value="ai_generated">AI 出题</option>
            <option value="crawled">爬虫导入</option>
            <option value="imported">批量导入</option>
          </select>
          <select v-model.number="config.examYear" class="count-input exam-year-filter" style="width:120px;text-align:left">
            <option :value="undefined">真题年份</option>
            <option v-for="year in recentExamYears" :key="year" :value="year">{{ year }}</option>
          </select>
          <select v-model="config.examPeriod" class="count-input" style="width:120px;text-align:left">
            <option :value="undefined">全部期次</option>
            <option value="H1">上半年</option>
            <option value="H2">下半年</option>
          </select>
        </div>
      </div>

      <div class="config-section">
        <label class="section-label">题目数量</label>
        <div class="count-row">
          <input type="number" v-model.number="config.count" class="count-input" min="1" max="100" />
          <span class="count-hint">道（建议 10~50）</span>
        </div>
      </div>

      <p v-if="startError" class="error-text">{{ startError }}</p>
      <button class="btn-primary start-btn" @click="startSession" :disabled="starting || !chosenTypes.length">
        {{ starting ? '加载题目…' : '开始练习' }}
      </button>
    </div>

    <!-- Answering Phase -->
    <div v-else-if="store.phase === 'answering'" class="answering-panel">
      <div class="progress-bar-wrap">
        <div class="progress-bar" :style="{ width: store.progress + '%' }"></div>
      </div>
      <div class="progress-label">{{ store.currentIndex }} / {{ store.questions.length }} 题 &nbsp;|&nbsp; 正确 {{ correctCount }} 道</div>

      <div v-if="store.currentQuestion" class="question-card">
        <div class="question-main">
          <div class="q-meta">
            <span class="type-badge" :class="store.currentQuestion.type">{{ { single:'单选', multiple:'多选', case:'案例', essay:'论文' }[store.currentQuestion.type] }}</span>
            <span v-for="i in store.currentQuestion.difficulty" :key="i" class="diff-stars">★</span>
          </div>
          <div class="q-content">{{ store.currentQuestion.content }}</div>

          <div v-if="store.currentQuestion.type === 'single'" class="options">
            <div v-for="(opt, i) in store.currentQuestion.options ?? []" :key="i"
                 class="option" :class="{ selected: chosenAnswer === optionLetters[i] }"
                 @click="chosenAnswer = optionLetters[i]">
              <span class="opt-letter">{{ optionLetters[i] }}</span>
              <span>{{ opt.replace(/^[A-F]\.\s*/, '') }}</span>
            </div>
          </div>

          <div v-else-if="store.currentQuestion.type === 'multiple'" class="options">
            <div v-for="(opt, i) in store.currentQuestion.options ?? []" :key="i"
                 class="option" :class="{ selected: isMultipleSelected(optionLetters[i]) }"
                 @click="toggleMultiple(optionLetters[i])">
              <span class="opt-letter multi" :class="{ checked: isMultipleSelected(optionLetters[i]) }">{{ optionLetters[i] }}</span>
              <span>{{ opt.replace(/^[A-F]\.\s*/, '') }}</span>
            </div>
          </div>

          <div v-else class="essay-area">
            <textarea v-model="essayAnswer" class="essay-textarea" rows="8" placeholder="在此输入你的答案…"></textarea>
          </div>

          <div class="submit-row">
            <button class="btn-primary submit-btn" @click="submitCurrent"
                    :disabled="store.currentQuestion.type !== 'essay' ? !chosenAnswer : !essayAnswer.trim()">
              提交答案
            </button>
            <button v-if="store.currentIndex >= store.questions.length - 1" class="btn-outline" @click="finishSession">结束练习</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Reviewing Phase -->
    <div v-else-if="store.phase === 'reviewing'" class="answering-panel">
      <div class="progress-bar-wrap">
        <div class="progress-bar" :style="{ width: store.progress + '%' }"></div>
      </div>
      <div class="progress-label">{{ store.currentIndex }} / {{ store.questions.length }} 题 &nbsp;|&nbsp; 正确 {{ correctCount }} 道</div>
      <div v-if="store.lastAnswer" class="question-card">
        <div class="review-panel">
          <div class="review-result" :class="store.lastAnswer.isCorrect ? 'correct' : 'wrong'">
            {{ store.lastAnswer.isCorrect ? '✓ 回答正确！' : '✗ 回答错误' }}
          </div>
          <div v-if="!store.lastAnswer.isCorrect && store.lastAnswer.answer" class="correct-ans">
            正确答案：<strong>{{ store.lastAnswer.answer }}</strong>
          </div>
          <div v-if="store.lastAnswer.explanation" class="explanation">
            <div class="exp-label">解析</div>
            <div class="exp-text">{{ store.lastAnswer.explanation }}</div>
          </div>
          <button class="btn-primary next-btn" @click="next">
            {{ store.isFinished ? '查看结果 →' : '下一题 →' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Done Phase -->
    <div v-else-if="store.phase === 'done'" class="done-panel">
      <div class="done-icon">{{ accuracy >= 70 ? '🎉' : accuracy >= 50 ? '📚' : '💪' }}</div>
      <h2 class="done-title">练习完成！</h2>
      <div class="done-stats">
        <div class="done-stat">
          <div class="done-val">{{ store.questions.length }}</div>
          <div class="done-key">总题数</div>
        </div>
        <div class="done-stat">
          <div class="done-val">{{ correctCount }}</div>
          <div class="done-key">答对数</div>
        </div>
        <div class="done-stat">
          <div class="done-val" :class="accuracy >= 70 ? 'good' : accuracy >= 50 ? 'ok' : 'bad'">{{ accuracy }}%</div>
          <div class="done-key">正确率</div>
        </div>
      </div>
      <button class="btn-primary" @click="restart">再来一次</button>
    </div>
  </div>
</template>

<style scoped>
.practice-view { display: flex; flex-direction: column; align-items: center; height: 100%; overflow-y: auto; }

.config-panel { width: 100%; max-width: 640px; display: flex; flex-direction: column; gap: 24px; padding: 8px 0; }
.config-panel h2 { font-size: 22px; font-weight: 700; color: var(--c-text); }
.config-section { display: flex; flex-direction: column; gap: 10px; }
.section-label { font-size: 13px; color: var(--c-text-2); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.mode-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mode-card { background: var(--c-panel); border: 2px solid var(--c-border); border-radius: 10px; padding: 14px; cursor: pointer; transition: border-color 0.15s; }
.mode-card:hover { border-color: var(--c-brand); }
.mode-card.active { border-color: #1d4ed8; background: #1e3a5f; }
.mode-name { font-size: 14px; font-weight: 600; color: var(--c-text); }
.mode-desc { font-size: 12px; color: var(--c-text-2); margin-top: 4px; }
.type-checks { display: flex; gap: 16px; flex-wrap: wrap; }
.check-label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-text); cursor: pointer; }
.count-row { display: flex; align-items: center; gap: 8px; }
.count-input { background: var(--c-panel); border: 1px solid var(--c-border-2); border-radius: 6px; color: var(--c-text); padding: 6px 10px; width: 80px; font-size: 14px; text-align: center; }
.count-hint { font-size: 13px; color: var(--c-text-2); }
.start-btn { align-self: flex-start; padding: 10px 32px; font-size: 15px; font-weight: 600; }

.answering-panel { width: 100%; max-width: 720px; display: flex; flex-direction: column; gap: 16px; }
.progress-bar-wrap { width: 100%; height: 4px; background: var(--c-border); border-radius: 2px; overflow: hidden; }
.progress-bar { height: 100%; background: #1d4ed8; transition: width 0.3s; }
.progress-label { font-size: 13px; color: var(--c-text-2); text-align: right; }
.question-card { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 12px; padding: 24px; }
.question-main { display: flex; flex-direction: column; gap: 16px; }
.q-meta { display: flex; align-items: center; gap: 8px; }
.type-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
.type-badge.single { background: #1e3a5f; color: var(--c-brand); }
.type-badge.multiple { background: var(--c-ok-bg); color: #4ade80; }
.type-badge.case { background: var(--c-warn-bg); color: #fb923c; }
.type-badge.essay { background: #3b0764; color: #c084fc; }
.diff-stars { color: #f59e0b; font-size: 12px; }
.q-content { font-size: 16px; color: var(--c-text); line-height: 1.7; white-space: pre-wrap; }
.options { display: flex; flex-direction: column; gap: 8px; }
.option { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border: 1px solid var(--c-border); border-radius: 8px; cursor: pointer; transition: border-color 0.15s, background 0.15s; font-size: 14px; color: var(--c-text); }
.option:hover { border-color: var(--c-brand); background: #1a2740; }
.option.selected { border-color: #1d4ed8; background: #1e3a5f; }
.opt-letter { min-width: 24px; height: 24px; border: 2px solid var(--c-border-2); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: var(--c-text-2); flex-shrink: 0; }
.option.selected .opt-letter { border-color: var(--c-brand); color: var(--c-brand); }
.opt-letter.multi { border-radius: 4px; }
.opt-letter.multi.checked { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
.essay-area { width: 100%; }
.essay-textarea { width: 100%; background: var(--c-bg); border: 1px solid var(--c-border-2); border-radius: 8px; color: var(--c-text); padding: 10px 12px; font-size: 14px; resize: vertical; font-family: inherit; line-height: 1.7; }
.submit-row { display: flex; gap: 10px; align-items: center; justify-content: flex-end; }
.submit-btn { padding: 8px 24px; }

.review-panel { display: flex; flex-direction: column; gap: 12px; }
.review-result { font-size: 18px; font-weight: 700; padding: 12px; border-radius: 8px; text-align: center; }
.review-result.correct { background: var(--c-ok-bg); color: #4ade80; }
.review-result.wrong { background: #450a0a; color: #f87171; }
.correct-ans { font-size: 14px; color: var(--c-text); }
.correct-ans strong { color: var(--c-brand); }
.explanation { background: var(--c-bg); border-radius: 8px; padding: 12px; }
.exp-label { font-size: 12px; color: var(--c-text-2); margin-bottom: 6px; font-weight: 600; }
.exp-text { font-size: 14px; color: #cbd5e1; line-height: 1.6; white-space: pre-wrap; }
.next-btn { align-self: flex-end; padding: 8px 24px; }

.done-panel { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 40px 0; }
.done-icon { font-size: 64px; }
.done-title { font-size: 28px; font-weight: 700; color: var(--c-text); }
.done-stats { display: flex; gap: 32px; }
.done-stat { text-align: center; }
.done-val { font-size: 36px; font-weight: 700; color: var(--c-brand); }
.done-val.good { color: #4ade80; }
.done-val.ok { color: #f59e0b; }
.done-val.bad { color: #f87171; }
.done-key { font-size: 13px; color: var(--c-text-2); margin-top: 4px; }

.btn-primary { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 20px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-outline { background: none; border: 1px solid var(--c-border-2); border-radius: 8px; color: var(--c-text-2); padding: 8px 20px; font-size: 14px; cursor: pointer; }
.btn-outline:hover { border-color: var(--c-text-2); color: var(--c-text); }
.error-text { color: #f87171; font-size: 13px; }
</style>
