<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { DocChunk } from '../stores/document'

const props = defineProps<{
  chunks: DocChunk[]
  docPageCount: number
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'clean'): void
  (e: 'rollback'): void
  (e: 'update-tag', chunkId: string, tags: string[], confidence: number | null): void
}>()

// ─── 持久化审核状态 ─────────────────────────────────────────────────────────
function reviewedStorageKey(): string {
  const docId = props.chunks[0]?.doc_id ?? 'unknown'
  return `tag-review:${docId}`
}

function loadReviewed(): Set<string> {
  try {
    const raw = localStorage.getItem(reviewedStorageKey())
    if (raw) return new Set(JSON.parse(raw))
  } catch { /* ignore */ }
  return new Set()
}

function saveReviewed(ids: Set<string>) {
  try {
    localStorage.setItem(reviewedStorageKey(), JSON.stringify([...ids]))
  } catch { /* ignore */ }
}

const reviewedIds = ref(loadReviewed())

// 组件挂载或 chunks 变化时重新加载
watch(() => props.chunks, () => {
  reviewedIds.value = loadReviewed()
})

const filter = ref<'review' | 'all' | 'noise' | 'low' | 'medium' | 'high' | 'empty'>('review')
const sortBy = ref<'page' | 'confidence-asc' | 'confidence-desc'>('confidence-asc')
const expandedId = ref<string | null>(null)
const editingChunkId = ref<string | null>(null)
const editTagsStr = ref('')
const editConfidence = ref<number | null>(null)
const cardRefs = ref<Record<string, HTMLElement | null>>({})

// ─── classification helpers ───────────────────────────────────────────────
type Level = 'noise' | 'low' | 'medium' | 'high' | 'unrated'

function noiseType(chunk: DocChunk): Level {
  const conf = chunk.confidence ?? null
  const hasTags = chunk.knowledge_tags.length > 0
  if (conf == null) return 'unrated'
  // 有标签 → 至少是需要审核的低置信度，不是噪音
  if (hasTags) {
    if (conf >= 0.7) return 'high'
    if (conf >= 0.4) return 'medium'
    return 'low'
  }
  // 无标签
  if (conf < 0.15) return 'noise'
  if (conf >= 0.7) return 'high'
  if (conf >= 0.4) return 'medium'
  return 'low'
}

const LEVEL_CONFIG: Record<Level, { cls: string; label: string; dot: string }> = {
  high:    { cls: 'lvl-high',    label: '高置信度', dot: '🟢' },
  medium:  { cls: 'lvl-medium',  label: '中置信度', dot: '🟡' },
  low:     { cls: 'lvl-low',     label: '低置信度', dot: '🟠' },
  noise:   { cls: 'lvl-noise',   label: '噪音',     dot: '🚫' },
  unrated: { cls: 'lvl-unrated', label: '未评级',   dot: '⬜' },
}

// ─── filtered & sorted chunks ─────────────────────────────────────────────
const reviewedChunks = computed(() => {
  let list = props.chunks.filter((c) => {
    const lvl = noiseType(c)
    switch (filter.value) {
      // 「待审核」= 需要人工确认的：低/中置信度 + 无标签(非噪音)
      case 'review': return lvl === 'low' || lvl === 'medium' || (c.knowledge_tags.length === 0 && lvl !== 'noise' && lvl !== 'unrated')
      case 'noise': return lvl === 'noise'
      case 'low': return lvl === 'low'
      case 'medium': return lvl === 'medium'
      case 'high': return lvl === 'high'
      case 'empty': return c.knowledge_tags.length === 0
      default: return true
    }
  })

  list = [...list].sort((a, b) => {
    switch (sortBy.value) {
      case 'confidence-asc': return (a.confidence ?? -1) - (b.confidence ?? -1)
      case 'confidence-desc': return (b.confidence ?? -1) - (a.confidence ?? -1)
      default: return a.page_num - b.page_num || a.block_order - b.block_order
    }
  })
  return list
})

const stats = computed(() => {
  let high = 0, medium = 0, low = 0, noise = 0, unrated = 0, empty = 0
  let review = 0  // low + medium + empty(非noise)
  for (const c of props.chunks) {
    const lvl = noiseType(c)
    if (lvl === 'high') high++
    else if (lvl === 'medium') { medium++; review++ }
    else if (lvl === 'low') { low++; review++ }
    else if (lvl === 'noise') noise++
    else unrated++
    if (c.knowledge_tags.length === 0 && lvl !== 'noise' && lvl !== 'unrated') review++
  }
  const total = props.chunks.length || 1
  return { high, medium, low, noise, unrated, empty: props.chunks.filter(c => c.knowledge_tags.length === 0).length, total, review }
})

function barPercent(count: number): string {
  return Math.max(1, (count / stats.value.total) * 100) + '%'
}

// ─── actions ──────────────────────────────────────────────────────────────
function setCardRef(id: string, el: Element | null) {
  cardRefs.value[id] = el as HTMLElement | null
}

function scrollToCard(id: string) {
  nextTick(() => {
    const el = cardRefs.value[id]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
  if (expandedId.value) scrollToCard(id)
}

function startEdit(chunk: DocChunk) {
  editingChunkId.value = editingChunkId.value === chunk.id ? null : chunk.id
  editTagsStr.value = chunk.knowledge_tags.join(', ')
  editConfidence.value = chunk.confidence
  if (editingChunkId.value) scrollToCard(chunk.id)
}

function cancelEdit() {
  editingChunkId.value = null
}

function persist(next: Set<string>) {
  reviewedIds.value = next
  saveReviewed(next)
}

function markReviewed(chunkId: string) {
  const next = new Set(reviewedIds.value)
  if (next.has(chunkId)) next.delete(chunkId)
  else next.add(chunkId)
  persist(next)
}

function batchApproveAll() {
  const next = new Set(reviewedIds.value)
  for (const c of reviewedChunks.value) {
    next.add(c.id)
  }
  persist(next)
}

function batchApproveHigh() {
  const next = new Set(reviewedIds.value)
  for (const c of props.chunks) {
    if (noiseType(c) === 'high') next.add(c.id)
  }
  persist(next)
}

function batchApproveNoise() {
  const next = new Set(reviewedIds.value)
  for (const c of props.chunks) {
    if (noiseType(c) === 'noise') next.add(c.id)
  }
  persist(next)
}

function resetReview() {
  persist(new Set())
}

function saveEdit(chunkId: string) {
  const tags = editTagsStr.value.split(',').map(s => s.trim()).filter(Boolean)
  emit('update-tag', chunkId, tags, editConfidence.value)
  editingChunkId.value = null
  const next = new Set(reviewedIds.value)
  next.add(chunkId)
  persist(next)
}

const FILTER_OPTIONS = [
  { v: 'review', label: '待审核' },
  { v: 'all',    label: '全部' },
  { v: 'high',   label: '高置信度' },
  { v: 'medium', label: '中置信度' },
  { v: 'low',    label: '低置信度' },
  { v: 'noise',  label: '噪音' },
  { v: 'empty',  label: '无标签' },
] as const
</script>

<template>
  <div class="tag-review">
    <!-- Stats bar with visual bars -->
    <div class="stats-bar">
      <div class="stats-left">
        <span class="stats-total">{{ stats.total }} 块</span>
        <span v-if="reviewedIds.size > 0" class="stats-reviewed">· ✅ {{ reviewedIds.size }}</span>
        <span v-if="reviewedIds.size < stats.total" class="stats-needs-review">· ⚠️ {{ stats.total - reviewedIds.size }} 待审核</span>
        <span v-else class="stats-done">· 🎉 全部完成</span>
      </div>
      <div class="stats-bars">
        <div class="stat-seg stat-seg-high" :style="{ flex: barPercent(stats.high) }" :title="'高置信度: ' + stats.high">
          <span v-if="stats.high > 0">{{ stats.high }}</span>
        </div>
        <div class="stat-seg stat-seg-medium" :style="{ flex: barPercent(stats.medium) }" :title="'中置信度: ' + stats.medium">
          <span v-if="stats.medium > 0">{{ stats.medium }}</span>
        </div>
        <div class="stat-seg stat-seg-low" :style="{ flex: barPercent(stats.low) }" :title="'低置信度: ' + stats.low">
          <span v-if="stats.low > 0">{{ stats.low }}</span>
        </div>
        <div class="stat-seg stat-seg-noise" :style="{ flex: barPercent(stats.noise) }" :title="'噪音: ' + stats.noise">
          <span v-if="stats.noise > 0">{{ stats.noise }}</span>
        </div>
        <div class="stat-seg stat-seg-unrated" :style="{ flex: barPercent(stats.unrated) }" :title="'未评级: ' + stats.unrated">
          <span v-if="stats.unrated > 0">{{ stats.unrated }}</span>
        </div>
      </div>
      <div class="stats-legend">
        <span class="legend-item">🟢 {{ stats.high }}</span>
        <span class="legend-item">🟡 {{ stats.medium }}</span>
        <span class="legend-item">🟠 {{ stats.low }}</span>
        <span class="legend-item">🚫 {{ stats.noise }}</span>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar-row">
      <div class="filter-btns">
        <button
          v-for="opt in FILTER_OPTIONS"
          :key="opt.v"
          class="fbtn"
          :class="{ active: filter === opt.v }"
          @click="filter = opt.v as typeof filter"
        >{{ opt.label }}</button>
      </div>
      <select v-model="sortBy" class="sort-sel">
        <option value="page">按页码排序</option>
        <option value="confidence-asc">置信度 ↑</option>
        <option value="confidence-desc">置信度 ↓</option>
      </select>
      <div class="batch-group">
        <button class="batch-btn" title="一键确认当前筛选结果" @click="batchApproveAll">✅ 确认当前</button>
        <button v-if="stats.high > 0" class="batch-btn batch-high" title="一键确认所有高置信度块" @click="batchApproveHigh">🟢 高置信度</button>
        <button v-if="stats.noise > 0" class="batch-btn batch-noise" title="一键确认所有噪音块已处理" @click="batchApproveNoise">🚫 噪音</button>
        <button v-if="reviewedIds.size > 0" class="batch-btn batch-reset" title="清除所有已确认标记" @click="resetReview">↩ 重置</button>
      </div>
      <button class="clean-btn" :disabled="loading" @click="$emit('clean')">
        {{ loading ? '清洗中…' : '🧹 清洗' }}
      </button>
    </div>

    <!-- chunk cards -->
    <div v-if="reviewedChunks.length === 0" class="empty-state">
      当前筛选条件下没有内容块
    </div>
    <div v-else class="card-list">
      <!-- key insight: 无标签 = 紧凑行；有标签 = 完整卡片 -->
      <template v-for="chunk in reviewedChunks" :key="chunk.id">
        <!-- ── 有标签：完整卡片 ── -->
        <div
          v-if="chunk.knowledge_tags.length > 0"
          :ref="(el: any) => setCardRef(chunk.id, el)"
          class="card"
          :class="{ 'card-expanded': expandedId === chunk.id }"
        >
          <div class="card-header" @click="toggleExpand(chunk.id)">
            <div class="card-check" @click.stop="markReviewed(chunk.id)">
              <span class="check-box" :class="{ 'check-done': reviewedIds.has(chunk.id) }">
                {{ reviewedIds.has(chunk.id) ? '✅' : '○' }}
              </span>
            </div>
            <div class="card-left">
              <span class="card-page">P{{ chunk.page_num }}</span>
              <span class="card-type" :class="'type-' + chunk.chunk_type">{{ chunk.chunk_type }}</span>
            </div>
            <div class="card-tags">
              <span v-for="tag in chunk.knowledge_tags" :key="tag" class="tag-pill">{{ tag }}</span>
            </div>
            <div class="card-right">
              <span class="card-level" :class="LEVEL_CONFIG[noiseType(chunk)].cls">
                {{ LEVEL_CONFIG[noiseType(chunk)].dot }}
              </span>
              <span v-if="chunk.confidence != null" class="card-conf">{{ (chunk.confidence * 100).toFixed(0) }}%</span>
              <span class="card-caret">{{ expandedId === chunk.id ? '▾' : '▸' }}</span>
            </div>
          </div>
          <div v-if="expandedId === chunk.id" class="card-body">
            <div class="card-text">{{ chunk.content }}</div>
            <div class="card-footer">
              <button class="edit-btn" @click.stop="startEdit(chunk)">✏️ 编辑标签</button>
            </div>
            <div v-if="editingChunkId === chunk.id" class="edit-panel" @click.stop>
              <input v-model="editTagsStr" class="edit-inline" placeholder="标签, 逗号分隔" @keyup.enter="saveEdit(chunk.id)" @keyup.escape="cancelEdit" />
              <input v-model.number="editConfidence" class="edit-inline edit-inline-num" type="number" min="0" max="1" step="0.01" placeholder="置信度" />
              <button class="save-btn" @click="saveEdit(chunk.id)">保存</button>
              <button class="cancel-btn" @click="cancelEdit">取消</button>
            </div>
          </div>
        </div>

        <!-- ── 无标签：紧凑行 ── -->
        <div
          v-else
          :ref="(el: any) => setCardRef(chunk.id, el)"
          class="row-compact"
          :class="{
            'row-noise': noiseType(chunk) === 'noise',
            'row-low': noiseType(chunk) === 'low',
            'row-medium': noiseType(chunk) === 'medium',
            'row-checked': reviewedIds.has(chunk.id),
          }"
          @click="toggleExpand(chunk.id)"
        >
          <div class="row-check" @click.stop="markReviewed(chunk.id)">
            <span class="check-box" :class="{ 'check-done': reviewedIds.has(chunk.id) }">
              {{ reviewedIds.has(chunk.id) ? '✅' : '○' }}
            </span>
          </div>
          <span class="row-page">P{{ chunk.page_num }}</span>
          <span class="row-type" :class="'type-' + chunk.chunk_type">{{ chunk.chunk_type }}</span>
          <span class="row-level" :class="LEVEL_CONFIG[noiseType(chunk)].cls">
            {{ LEVEL_CONFIG[noiseType(chunk)].dot }} {{ LEVEL_CONFIG[noiseType(chunk)].label }}
          </span>
          <span v-if="chunk.confidence != null" class="row-conf">{{ (chunk.confidence * 100).toFixed(0) }}%</span>
          <span class="row-snippet">{{ chunk.content.slice(0, 60).replace(/\n/g, ' ') }}{{ chunk.content.length > 60 ? '…' : '' }}</span>
        </div>

        <!-- expanded body for compact row -->
        <div v-if="expandedId === chunk.id && chunk.knowledge_tags.length === 0" class="card-body card-body-standalone">
          <div class="card-text">{{ chunk.content }}</div>
          <div class="card-footer">
            <button class="edit-btn" @click.stop="startEdit(chunk)">✏️ 添加标签</button>
          </div>
          <div v-if="editingChunkId === chunk.id" class="edit-panel" @click.stop>
            <input v-model="editTagsStr" class="edit-inline" placeholder="标签, 逗号分隔" @keyup.enter="saveEdit(chunk.id)" @keyup.escape="cancelEdit" />
            <input v-model.number="editConfidence" class="edit-inline edit-inline-num" type="number" min="0" max="1" step="0.01" placeholder="置信度" />
            <button class="save-btn" @click="saveEdit(chunk.id)">保存</button>
            <button class="cancel-btn" @click="cancelEdit">取消</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tag-review {
  display: flex;
  flex-direction: column;
  background: #0b1120;
}

/* ── stats bar ──────────────────────────────────────────── */
.stats-bar {
  padding: 10px 16px;
  border-bottom: 1px solid #1e293b;
  display: flex;
  align-items: center;
  gap: 16px;
}
.stats-left { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.stats-total { font-size: 13px; color: #94a3b8; font-weight: 600; }
.stats-needs-review { font-size: 12px; color: #fbbf24; font-weight: 600; }
.stats-reviewed { font-size: 12px; color: #86efac; font-weight: 600; }
.stats-done { font-size: 12px; color: #86efac; font-weight: 700; }
.stats-bars {
  flex: 1;
  display: flex;
  height: 20px;
  border-radius: 10px;
  overflow: hidden;
  gap: 1px;
  background: #1e293b;
}
.stat-seg {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  min-width: 2px;
  transition: flex 0.3s;
}
.stat-seg-high    { background: #166534; }
.stat-seg-medium  { background: #1e3a5f; }
.stat-seg-low     { background: #78350f; }
.stat-seg-noise   { background: #7f1d1d; }
.stat-seg-unrated { background: #334155; }
.stats-legend {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.legend-item {
  font-size: 11px;
  color: #94a3b8;
}

/* ── toolbar ───────────────────────────────────────────── */
.toolbar-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #1e293b;
}
.filter-btns {
  display: flex;
  gap: 6px;
  flex: 1;
}
.fbtn {
  padding: 5px 14px;
  border: 1px solid #1e293b;
  border-radius: 20px;
  font-size: 12px;
  background: #111926;
  color: #94a3b8;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.fbtn:hover { background: #1e293b; color: #e2e8f0; }
.fbtn.active {
  background: #1e3a5f;
  color: #93c5fd;
  border-color: #33527d;
  font-weight: 600;
}
.sort-sel {
  padding: 5px 10px;
  border: 1px solid #1e293b;
  border-radius: 8px;
  font-size: 12px;
  background: #111926;
  color: #e2e8f0;
  cursor: pointer;
  flex-shrink: 0;
}
.batch-group {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.batch-btn {
  padding: 5px 10px;
  border: 1px solid #334155;
  border-radius: 6px;
  font-size: 11px;
  background: #1e293b;
  color: #94a3b8;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s;
}
.batch-btn:hover { background: #334155; color: #e2e8f0; }
.batch-btn.batch-high { border-color: #166534; color: #86efac; }
.batch-btn.batch-high:hover { background: #16653433; }
.batch-btn.batch-noise { border-color: #7f1d1d; color: #fca5a5; }
.batch-btn.batch-noise:hover { background: #7f1d1d33; }
.batch-btn.batch-reset { border-color: #475569; color: #94a3b8; }
.batch-btn.batch-reset:hover { background: #334155; color: #e2e8f0; }

.clean-btn {
  padding: 6px 16px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  font-weight: 600;
  transition: background 0.15s;
}
.clean-btn:hover:not(:disabled) { background: #3b82f6; }
.clean-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── card list ─────────────────────────────────────────── */
.card-list {
  padding: 12px 16px 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card {
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.15s;
}
.card-expanded { border-color: #33527d; }
.card-check {
  flex-shrink: 0;
  cursor: pointer;
  padding: 2px;
}
.check-box {
  font-size: 16px;
  color: #334155;
  transition: color 0.15s;
}
.check-box.check-done { color: #86efac; }
.card-check:hover .check-box:not(.check-done) { color: #64748b; }

.card-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  cursor: pointer;
  user-select: none;
  min-height: 46px;
}
.card-header:hover { background: #1e293b33; }
.card-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.card-page { font-size: 13px; color: #cbd5e1; font-weight: 600; width: 52px; flex-shrink: 0; }
.card-type {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.type-text          { background: #334155; color: #94a3b8; }
.type-table         { background: #14532d; color: #86efac; }
.type-figure        { background: #4a044e; color: #e879f9; }
.type-page_summary  { background: #1e3a5f; color: #93c5fd; }
.card-level {
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}
.lvl-high    { background: #14532d33; color: #86efac; }
.lvl-medium  { background: #1e3a5f33; color: #93c5fd; }
.lvl-low     { background: #78350f33; color: #fbbf24; }
.lvl-noise   { background: #7f1d1d33; color: #fca5a5; }
.lvl-unrated { background: #33415533; color: #94a3b8; }

.card-tags {
  display: flex;
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  min-width: 0;
}
.tag-pill {
  font-size: 12px;
  padding: 3px 10px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 14px;
  color: #e2e8f0;
  white-space: nowrap;
  font-weight: 500;
}
.no-tags { font-size: 12px; color: #475569; }

.card-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.card-conf { font-size: 13px; color: #64748b; font-weight: 600; font-variant-numeric: tabular-nums; }
.card-caret { font-size: 12px; color: #475569; }

/* ── card body ────────────────────────────────────────── */
.card-body {
  border-top: 1px solid #1e293b;
  padding: 14px;
}
.card-text {
  font-size: 13px;
  color: #94a3b8;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
  padding: 10px 12px;
  background: #060b14;
  border-radius: 8px;
  border: 1px solid #1e293b;
}
.card-footer {
  margin-top: 12px;
}
.edit-btn {
  padding: 5px 14px;
  border: 1px solid #334155;
  border-radius: 6px;
  font-size: 12px;
  background: #0f172a;
  color: #cbd5e1;
  cursor: pointer;
  transition: all 0.15s;
}
.edit-btn:hover { background: #1e293b; border-color: #475569; }

/* ── edit panel ───────────────────────────────────────── */
.edit-panel {
  margin-top: 10px;
  padding: 10px 12px;
  background: #060b14;
  border: 1px solid #33527d;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.edit-inline {
  flex: 1;
  min-width: 180px;
  padding: 7px 10px;
  border: 1px solid #334155;
  border-radius: 6px;
  font-size: 13px;
  background: #0f172a;
  color: #e2e8f0;
  outline: none;
}
.edit-inline:focus { border-color: #3b82f6; }
.edit-inline-num {
  flex: none;
  width: 90px;
  min-width: 90px;
}
.save-btn {
  padding: 6px 16px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
  flex-shrink: 0;
}
.save-btn:hover { background: #3b82f6; }
.cancel-btn {
  padding: 6px 12px;
  background: #1e293b;
  color: #cbd5e1;
  border: 1px solid #334155;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}
.cancel-btn:hover { background: #334155; }

.card-body-standalone {
  border-top: none;
  border: 1px solid #33527d;
  border-top: 1px solid #33527d;
  border-radius: 0 0 8px 8px;
  margin-bottom: 8px;
}

/* ── compact row (no-tag chunks) ─────────────────────────── */
.row-compact {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px;
  background: #0b1120;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.12s;
  min-height: 32px;
  line-height: 1.4;
}
.row-compact:hover { background: #1a2332; border-color: #1e293b; }
.row-compact.row-noise { border-left: 3px solid #991b1b; }  /* 噪音突出 */
.row-compact.row-low { border-left: 3px solid #78350f; }     /* 低置信度弱标记 */
.row-compact.row-checked { opacity: 0.55; }                   /* 已审核：变淡 */

.row-check {
  flex-shrink: 0;
  cursor: pointer;
  padding: 2px;
}
.row-compact .check-box { font-size: 14px; }
.row-page {
  width: 38px;
  color: #64748b;
  font-weight: 600;
  flex-shrink: 0;
  font-size: 11px;
}
.row-type {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
  flex-shrink: 0;
}
.row-level {
  font-size: 11px;
  flex-shrink: 0;
  white-space: nowrap;
}
.row-level.lvl-noise   { color: #fca5a5; }
.row-level.lvl-low     { color: #fbbf24; }
.row-level.lvl-medium  { color: #93c5fd; }
.row-level.lvl-high    { color: #86efac; }
.row-level.lvl-unrated { color: #64748b; }

.row-conf {
  width: 36px;
  text-align: right;
  color: #475569;
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
}
.row-snippet {
  flex: 1;
  color: #475569;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-size: 11px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #475569;
  font-size: 14px;
}
</style>
