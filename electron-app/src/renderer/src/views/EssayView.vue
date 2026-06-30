<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useEssayStore, SECTION_CONFIG, type EssayMaterial } from '../stores/essay'

const store = useEssayStore()

const activeTab = ref<'editor' | 'materials'>('editor')
const showVersions = ref(false)
const showMatEdit = ref(false)
const editMat = ref<Partial<EssayMaterial>>({})
const savingMat = ref(false)
const matTagInput = ref('')
const expandedSection = ref<string | null>('abstract')
const debounceTimers = ref<Record<string, ReturnType<typeof setTimeout>>>({})
const savingVersion = ref(false)

onMounted(async () => {
  await Promise.all([store.fetchList(), store.fetchMaterials()])
})

async function newEssay() {
  const essay = await store.create()
  await store.openEssay(essay.id)
}

function sectionContent(key: string) {
  return store.sections.find((s) => s.section_key === key)?.content ?? ''
}

function sectionWordCount(key: string) {
  return store.sections.find((s) => s.section_key === key)?.word_count ?? 0
}

function wordCountColor(count: number, target: number) {
  if (count === 0) return '#475569'
  const ratio = count / target
  if (ratio >= 0.8 && ratio <= 1.3) return '#4ade80'
  if (ratio > 1.3) return '#f87171'
  return '#fb923c'
}

function onSectionInput(key: string, event: Event) {
  const content = (event.target as HTMLTextAreaElement).value
  clearTimeout(debounceTimers.value[key])
  debounceTimers.value[key] = setTimeout(() => {
    store.updateSection(key, content)
  }, 600)
}

async function doSaveVersion() {
  savingVersion.value = true
  try {
    await store.saveVersion()
    await store.fetchVersions()
    showVersions.value = true
  } finally {
    savingVersion.value = false
  }
}

function openMatNew() {
  editMat.value = { project_name: '', background: '', challenges: '', solution: '', outcomes: '', knowledge_tags: [] }
  matTagInput.value = ''
  showMatEdit.value = true
}

function openMatEdit(mat: EssayMaterial) {
  editMat.value = { ...mat, knowledge_tags: [...mat.knowledge_tags] }
  matTagInput.value = ''
  showMatEdit.value = true
}

function addMatTag() {
  const t = matTagInput.value.trim()
  if (!t) return
  editMat.value.knowledge_tags = [...(editMat.value.knowledge_tags ?? []), t]
  matTagInput.value = ''
}

async function saveMat() {
  if (!editMat.value.project_name?.trim()) return
  savingMat.value = true
  try {
    await store.upsertMaterial(editMat.value)
    showMatEdit.value = false
  } finally {
    savingMat.value = false
  }
}

function insertMaterialIntoSection(mat: EssayMaterial) {
  const summary = `${mat.project_name}：${mat.background.slice(0, 50)}…`
  const key = expandedSection.value ?? 'background'
  const current = sectionContent(key)
  store.updateSection(key, current + '\n' + summary)
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const totalTarget = SECTION_CONFIG.reduce((sum, s) => sum + s.target, 0)
</script>

<template>
  <div class="essay-view">
    <!-- Sidebar: essay list -->
    <div class="essay-sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">我的论文</span>
        <button class="icon-add" @click="newEssay" title="新建">+</button>
      </div>
      <div v-if="store.loading" class="empty-tip">加载中…</div>
      <div v-else-if="store.essays.length === 0" class="empty-tip">
        <div style="font-size:24px;margin-bottom:4px">✍</div>
        <div>还没有论文草稿</div>
      </div>
      <div
        v-for="essay in store.essays"
        :key="essay.id"
        class="essay-item"
        :class="{ active: store.activeEssay?.id === essay.id }"
        @click="store.openEssay(essay.id)"
      >
        <div class="essay-item-title">{{ essay.title }}</div>
        <div class="essay-item-meta">{{ essay.word_count }} 字 · v{{ essay.version }}</div>
        <button class="icon-del" @click.stop="store.removeEssay(essay.id)" title="删除">✕</button>
      </div>
    </div>

    <!-- Main content -->
    <div class="essay-main">
      <div v-if="!store.activeEssay" class="no-essay">
        <div style="font-size:48px;margin-bottom:12px">✍</div>
        <div>从左侧选择一篇论文，或点击 + 新建</div>
      </div>
      <template v-else>
        <!-- Tabs -->
        <div class="main-header">
          <div class="tabs">
            <button class="tab" :class="{ active: activeTab === 'editor' }" @click="activeTab = 'editor'">论文编辑</button>
            <button class="tab" :class="{ active: activeTab === 'materials' }" @click="activeTab = 'materials'">素材库</button>
          </div>
          <div class="header-actions">
            <div class="word-count-total" :style="{ color: wordCountColor(store.totalWordCount, totalTarget) }">
              {{ store.totalWordCount }} / {{ totalTarget }} 字
            </div>
            <button class="btn-sm" @click="showVersions = true">📋 版本历史</button>
            <button class="btn-sm btn-primary" @click="doSaveVersion" :disabled="savingVersion">
              {{ savingVersion ? '保存中…' : '💾 保存版本' }}
            </button>
          </div>
        </div>

        <!-- Editor tab -->
        <div v-if="activeTab === 'editor'" class="editor-panel">
          <!-- Title + Question -->
          <div class="meta-row">
            <input
              :value="store.activeEssay.title"
              class="title-input"
              placeholder="论文标题"
              @change="store.updateMeta({ title: ($event.target as HTMLInputElement).value })"
            />
          </div>
          <div class="meta-row">
            <textarea
              :value="store.activeEssay.question"
              class="question-input"
              rows="2"
              placeholder="论文题目 / 考题要求（粘贴到此处）"
              @change="store.updateMeta({ question: ($event.target as HTMLTextAreaElement).value })"
            ></textarea>
          </div>

          <!-- Sections -->
          <div class="sections-wrap">
            <div
              v-for="sec in SECTION_CONFIG"
              :key="sec.key"
              class="section-card"
            >
              <div class="section-header" @click="expandedSection = expandedSection === sec.key ? null : sec.key">
                <div class="section-left">
                  <span class="section-key">{{ expandedSection === sec.key ? '▼' : '▶' }}</span>
                  <span class="section-label">{{ sec.label }}</span>
                </div>
                <div class="section-right">
                  <span class="word-count" :style="{ color: wordCountColor(sectionWordCount(sec.key), sec.target) }">
                    {{ sectionWordCount(sec.key) }} / {{ sec.target }}
                  </span>
                  <div class="wc-bar-bg">
                    <div
                      class="wc-bar"
                      :style="{
                        width: Math.min(100, (sectionWordCount(sec.key) / sec.target) * 100) + '%',
                        background: wordCountColor(sectionWordCount(sec.key), sec.target)
                      }"
                    ></div>
                  </div>
                  <button
                    v-if="expandedSection === sec.key"
                    class="suggest-btn"
                    :disabled="store.suggesting[sec.key]"
                    @click.stop="store.getSuggestion(sec.key, sec.label, sec.target)"
                    title="AI写作建议"
                  >
                    {{ store.suggesting[sec.key] ? '…' : '✦ AI建议' }}
                  </button>
                </div>
              </div>
              <div v-if="expandedSection === sec.key" class="section-body">
                <p class="section-hint">{{ sec.hint }}</p>
                <textarea
                  class="section-textarea"
                  :value="sectionContent(sec.key)"
                  :placeholder="`在此输入${sec.label}内容…`"
                  :rows="Math.ceil(sec.target / 30)"
                  @input="onSectionInput(sec.key, $event)"
                ></textarea>
                <div v-if="store.suggestions[sec.key]" class="ai-suggestions">
                  <div class="ai-suggest-header">✦ AI 写作建议</div>
                  <div class="ai-suggest-content">{{ store.suggestions[sec.key] }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Materials tab -->
        <div v-if="activeTab === 'materials'" class="materials-panel">
          <div class="mat-toolbar">
            <span class="label-sm">{{ store.materials.length }} 条素材</span>
            <button class="btn-sm btn-primary" @click="openMatNew">+ 新建素材</button>
          </div>
          <div v-if="store.materials.length === 0" class="empty-tip">
            <div style="font-size:32px;margin-bottom:8px">📚</div>
            <div>素材库为空，添加项目经验素材便于写作时引用</div>
          </div>
          <div class="mat-list">
            <div v-for="mat in store.materials" :key="mat.id" class="mat-card">
              <div class="mat-header">
                <span class="mat-name">{{ mat.project_name }}</span>
                <div class="mat-actions">
                  <button class="icon-btn" @click="insertMaterialIntoSection(mat)" title="插入到当前段落">↵</button>
                  <button class="icon-btn" @click="openMatEdit(mat)">✎</button>
                  <button class="icon-btn danger" @click="store.removeMaterial(mat.id)">✕</button>
                </div>
              </div>
              <div class="mat-row"><span class="mat-field-label">背景</span>{{ mat.background.slice(0, 80) || '—' }}</div>
              <div class="mat-row"><span class="mat-field-label">挑战</span>{{ mat.challenges.slice(0, 80) || '—' }}</div>
              <div class="mat-tags">
                <span v-for="tag in mat.knowledge_tags" :key="tag" class="tag">{{ tag }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- Version history panel -->
    <div v-if="showVersions" class="modal-backdrop" @click.self="showVersions = false">
      <div class="modal">
        <div class="modal-header">
          <h3>版本历史</h3>
          <button class="close-btn" @click="showVersions = false">✕</button>
        </div>
        <div class="modal-body">
          <div v-if="store.versions.length === 0" class="empty-tip">暂无保存的版本</div>
          <div v-else class="ver-list">
            <div v-for="ver in store.versions" :key="ver.id" class="ver-item">
              <div class="ver-info">
                <span class="ver-num">v{{ ver.version }}</span>
                <span class="ver-date">{{ formatDate(ver.saved_at) }}</span>
              </div>
              <button class="btn-sm" @click="store.restoreVersion(ver.id); showVersions = false">恢复此版本</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Material edit modal -->
    <div v-if="showMatEdit" class="modal-backdrop" @click.self="showMatEdit = false">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ editMat.id ? '编辑素材' : '新建素材' }}</h3>
          <button class="close-btn" @click="showMatEdit = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>项目名称 *</label>
            <input v-model="editMat.project_name" class="input-sm" placeholder="例：某电商平台微服务改造项目" />
          </div>
          <div class="form-group">
            <label>项目背景</label>
            <textarea v-model="editMat.background" class="textarea" rows="3" placeholder="项目背景、行业现状…"></textarea>
          </div>
          <div class="form-group">
            <label>主要挑战</label>
            <textarea v-model="editMat.challenges" class="textarea" rows="3" placeholder="面临的技术挑战…"></textarea>
          </div>
          <div class="form-group">
            <label>技术方案</label>
            <textarea v-model="editMat.solution" class="textarea" rows="3" placeholder="采用的技术架构和方案…"></textarea>
          </div>
          <div class="form-group">
            <label>项目成果</label>
            <textarea v-model="editMat.outcomes" class="textarea" rows="2" placeholder="性能提升数据、用户增长等…"></textarea>
          </div>
          <div class="form-group">
            <label>知识点标签</label>
            <div class="tags-row">
              <span v-for="(tag, i) in editMat.knowledge_tags" :key="i" class="tag editable">
                {{ tag }}<button @click="editMat.knowledge_tags!.splice(i, 1)">✕</button>
              </span>
              <input v-model="matTagInput" class="tag-input" placeholder="回车添加" @keyup.enter="addMatTag" />
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-sm" @click="showMatEdit = false">取消</button>
          <button class="btn-sm btn-primary" @click="saveMat" :disabled="savingMat">
            {{ savingMat ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.essay-view { display: flex; height: 100%; gap: 0; overflow: hidden; }

/* Sidebar */
.essay-sidebar { width: 220px; background: #1e293b; border-right: 1px solid #334155; display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 8px; border-bottom: 1px solid #334155; }
.sidebar-title { font-size: 14px; font-weight: 700; color: #e2e8f0; }
.icon-add { background: #1d4ed8; border: none; border-radius: 6px; color: #fff; width: 24px; height: 24px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
.essay-item { padding: 10px 12px; border-bottom: 1px solid #334155; cursor: pointer; position: relative; }
.essay-item:hover { background: #1a2740; }
.essay-item.active { background: #1e3a5f; }
.essay-item-title { font-size: 13px; font-weight: 600; color: #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 20px; }
.essay-item-meta { font-size: 11px; color: #64748b; margin-top: 2px; }
.icon-del { position: absolute; top: 8px; right: 8px; background: none; border: none; color: #64748b; cursor: pointer; font-size: 12px; opacity: 0; }
.essay-item:hover .icon-del { opacity: 1; }

/* Main */
.essay-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #0f172a; }
.no-essay { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #475569; font-size: 14px; }
.main-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid #334155; background: #1e293b; flex-shrink: 0; gap: 12px; }
.tabs { display: flex; gap: 4px; }
.tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 14px; font-size: 13px; color: #94a3b8; cursor: pointer; }
.tab:hover { color: #e2e8f0; }
.tab.active { color: #60a5fa; border-bottom-color: #60a5fa; }
.header-actions { display: flex; align-items: center; gap: 8px; }
.word-count-total { font-size: 13px; font-weight: 600; }
.btn-sm { background: #334155; border: none; border-radius: 6px; color: #e2e8f0; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.btn-sm:hover:not(:disabled) { background: #475569; }
.btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: #1d4ed8 !important; }
.btn-primary:hover:not(:disabled) { background: #2563eb !important; }

/* Editor */
.editor-panel { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; }
.meta-row { display: flex; gap: 8px; }
.title-input { flex: 1; background: #1e293b; border: 1px solid #475569; border-radius: 8px; color: #e2e8f0; padding: 8px 12px; font-size: 16px; font-weight: 700; }
.question-input { flex: 1; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #94a3b8; padding: 8px 12px; font-size: 13px; resize: none; font-family: inherit; }

.sections-wrap { display: flex; flex-direction: column; gap: 6px; }
.section-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; }
.section-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; cursor: pointer; }
.section-header:hover { background: #1a2740; }
.section-left { display: flex; align-items: center; gap: 8px; }
.section-key { font-size: 12px; color: #64748b; width: 14px; }
.section-label { font-size: 13px; font-weight: 600; color: #e2e8f0; }
.section-right { display: flex; align-items: center; gap: 8px; }
.word-count { font-size: 12px; font-weight: 600; min-width: 60px; text-align: right; }
.wc-bar-bg { width: 60px; height: 4px; background: #334155; border-radius: 2px; overflow: hidden; }
.wc-bar { height: 100%; border-radius: 2px; transition: width 0.3s, background 0.3s; }
.suggest-btn { background: #1e3a5f; border: none; border-radius: 4px; color: #60a5fa; padding: 3px 8px; font-size: 11px; cursor: pointer; }
.suggest-btn:hover:not(:disabled) { background: #1d4ed8; color: #fff; }
.suggest-btn:disabled { opacity: 0.5; }
.section-body { border-top: 1px solid #334155; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.section-hint { font-size: 12px; color: #475569; margin: 0; }
.section-textarea { width: 100%; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0; padding: 8px 10px; font-size: 13px; resize: vertical; font-family: inherit; line-height: 1.7; }
.ai-suggestions { background: #0f172a; border: 1px solid #1e3a5f; border-radius: 6px; padding: 10px 12px; }
.ai-suggest-header { font-size: 11px; color: #60a5fa; font-weight: 600; margin-bottom: 6px; }
.ai-suggest-content { font-size: 13px; color: #cbd5e1; line-height: 1.7; white-space: pre-line; }

/* Materials */
.materials-panel { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.mat-toolbar { display: flex; align-items: center; justify-content: space-between; }
.label-sm { font-size: 12px; color: #94a3b8; }
.mat-list { display: flex; flex-direction: column; gap: 8px; }
.mat-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px; }
.mat-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.mat-name { font-size: 14px; font-weight: 600; color: #e2e8f0; }
.mat-actions { display: flex; gap: 4px; }
.icon-btn { background: none; border: 1px solid #475569; border-radius: 4px; color: #94a3b8; width: 26px; height: 26px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 13px; }
.icon-btn:hover { border-color: #94a3b8; color: #e2e8f0; }
.icon-btn.danger:hover { border-color: #f87171; color: #f87171; }
.mat-row { font-size: 12px; color: #94a3b8; margin: 3px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mat-field-label { color: #475569; margin-right: 6px; }
.mat-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.tag { display: inline-block; background: #1e3a5f; color: #93c5fd; border-radius: 4px; padding: 1px 6px; font-size: 11px; }
.tag.editable button { background: none; border: none; color: #93c5fd; cursor: pointer; margin-left: 2px; }
.tag-input { background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0; padding: 4px 8px; font-size: 12px; width: 100px; }

/* Modals */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: #1e293b; border: 1px solid #334155; border-radius: 12px; width: 560px; max-height: 80vh; display: flex; flex-direction: column; }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #334155; }
.modal-header h3 { font-size: 15px; font-weight: 700; color: #e2e8f0; }
.close-btn { background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; }
.modal-body { flex: 1; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 18px; border-top: 1px solid #334155; }
.form-group { display: flex; flex-direction: column; gap: 4px; }
.form-group label { font-size: 12px; color: #94a3b8; }
.input-sm { background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0; padding: 6px 10px; font-size: 13px; }
.textarea { width: 100%; background: #0f172a; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0; padding: 7px 10px; font-size: 13px; resize: vertical; font-family: inherit; }
.tags-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }

.ver-list { display: flex; flex-direction: column; gap: 8px; }
.ver-item { display: flex; align-items: center; justify-content: space-between; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 12px; }
.ver-info { display: flex; align-items: center; gap: 12px; }
.ver-num { font-size: 13px; font-weight: 600; color: #60a5fa; }
.ver-date { font-size: 12px; color: #94a3b8; }

.empty-tip { text-align: center; padding: 32px; color: #475569; font-size: 13px; }
</style>
