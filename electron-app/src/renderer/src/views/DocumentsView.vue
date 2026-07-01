<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useDocumentStore, type Doc, type DocChunk } from '../stores/document'
const store = useDocumentStore()

const selectedDoc = ref<Doc | null>(null)
const chunks = ref<DocChunk[]>([])
const loadingChunks = ref(false)
const importError = ref('')
const importing = ref(false)

onMounted(() => store.fetchAll())

async function doImport() {
  importError.value = ''
  importing.value = true
  try {
    const result = await store.importPdf()
    if (!result) return  // cancelled
    if (result.duplicate) { importError.value = '该文档已导入（MD5 重复）'; return }
    if (result.taskId) {
      // Watch task progress
    }
  } catch (e) {
    importError.value = String(e)
  } finally {
    importing.value = false
  }
}

async function openDoc(doc: Doc) {
  selectedDoc.value = doc
  loadingChunks.value = true
  try {
    chunks.value = await store.getChunks(doc.id)
  } finally {
    loadingChunks.value = false
  }
}

async function deleteDoc(doc: Doc) {
  if (!confirm(`确认删除文档《${doc.title}》及其全部内容块？`)) return
  await store.remove(doc.id)
  if (selectedDoc.value?.id === doc.id) { selectedDoc.value = null; chunks.value = [] }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

</script>

<template>
  <div class="doc-view">
    <!-- Toolbar -->
    <div class="toolbar">
      <h2 class="view-title">文档库</h2>
      <button class="btn-primary" @click="doImport" :disabled="importing">
        {{ importing ? '导入中…' : '+ 导入 PDF' }}
      </button>
    </div>
    <p v-if="importError" class="error-text">{{ importError }}</p>

    <div class="main-layout">
      <!-- Doc list -->
      <div class="doc-list">
        <div v-if="store.loading" class="empty-tip">加载中…</div>
        <div v-else-if="store.documents.length === 0" class="empty-tip">
          <div style="font-size:40px;margin-bottom:8px">📄</div>
          <div>还没有导入文档</div>
          <div style="font-size:12px;margin-top:4px;color:var(--c-text-3)">点击上方「导入 PDF」开始</div>
        </div>
        <div v-for="doc in store.documents" :key="doc.id"
             class="doc-item" :class="{ active: selectedDoc?.id === doc.id }"
             @click="openDoc(doc)">
          <div class="doc-icon">📄</div>
          <div class="doc-info">
            <div class="doc-title">{{ doc.title }}</div>
            <div class="doc-meta">{{ doc.page_count > 0 ? `${doc.page_count} 页` : '解析中…' }} &nbsp;·&nbsp; {{ formatDate(doc.imported_at) }}</div>
          </div>
          <button class="icon-btn danger" @click.stop="deleteDoc(doc)" title="删除">✕</button>
        </div>
      </div>

      <!-- Chunks panel -->
      <div class="chunks-panel">
        <div v-if="!selectedDoc" class="empty-tip" style="height:100%;display:flex;align-items:center;justify-content:center;">
          <div style="text-align:center;color:var(--c-border-2)">
            <div style="font-size:36px;margin-bottom:8px">←</div>
            <div>点击左侧文档查看内容块</div>
          </div>
        </div>
        <template v-else>
          <div class="chunks-header">
            <h3>{{ selectedDoc.title }}</h3>
            <span class="chunk-count">{{ loadingChunks ? '…' : chunks.length }} 个内容块</span>
          </div>
          <div v-if="loadingChunks" class="empty-tip">加载内容块…</div>
          <div v-else class="chunks-list">
            <div v-for="chunk in chunks" :key="chunk.id" class="chunk-item">
              <div class="chunk-page">第 {{ chunk.page_num }} 页</div>
              <div class="chunk-content">{{ chunk.content }}</div>
              <div class="chunk-tags">
                <span v-for="tag in chunk.knowledge_tags" :key="tag" class="tag">{{ tag }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.doc-view { display: flex; flex-direction: column; height: 100%; gap: 12px; }
.toolbar { display: flex; align-items: center; gap: 12px; }
.view-title { font-size: 20px; font-weight: 700; color: var(--c-text); flex: 1; }
.error-text { color: #f87171; font-size: 13px; }
.btn-primary { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.main-layout { flex: 1; display: grid; grid-template-columns: 280px 1fr; gap: 12px; overflow: hidden; }

.doc-list { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 0; }
.doc-item { display: flex; align-items: center; gap: 10px; padding: 12px; border-bottom: 1px solid var(--c-border); cursor: pointer; transition: background 0.15s; }
.doc-item:hover { background: #1a2740; }
.doc-item.active { background: #1e3a5f; }
.doc-icon { font-size: 24px; flex-shrink: 0; }
.doc-info { flex: 1; min-width: 0; }
.doc-title { font-size: 13px; font-weight: 600; color: var(--c-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.doc-meta { font-size: 11px; color: var(--c-text-3); margin-top: 2px; }
.icon-btn { background: none; border: 1px solid var(--c-border-2); border-radius: 4px; color: var(--c-text-2); width: 24px; height: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
.icon-btn.danger:hover { border-color: #f87171; color: #f87171; }

.chunks-panel { background: var(--c-panel); border: 1px solid var(--c-border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
.chunks-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--c-border); }
.chunks-header h3 { font-size: 15px; font-weight: 600; color: var(--c-text); }
.chunk-count { font-size: 12px; color: var(--c-text-3); }
.chunks-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.chunk-item { background: var(--c-bg); border: 1px solid var(--c-border); border-radius: 8px; padding: 12px; }
.chunk-page { font-size: 11px; color: var(--c-text-3); margin-bottom: 6px; }
.chunk-content { font-size: 13px; color: #cbd5e1; line-height: 1.6; max-height: 120px; overflow: hidden; position: relative; }
.chunk-content::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 30px; background: linear-gradient(transparent, var(--c-bg)); }
.chunk-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.tag { display: inline-block; background: #1e3a5f; color: #93c5fd; border-radius: 4px; padding: 1px 6px; font-size: 11px; }
.empty-tip { text-align: center; padding: 48px; color: var(--c-border-2); font-size: 13px; }
</style>
