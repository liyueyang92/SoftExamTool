<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'

interface GraphNode {
  id: string
  name: string
  questionCount: number
  docCount: number
  value: number
}

interface GraphEdge {
  source: string
  target: string
  value: number
}

const chartRef = ref<HTMLDivElement | null>(null)
const loading = ref(false)
const error = ref('')
const nodes = ref<GraphNode[]>([])
const edges = ref<GraphEdge[]>([])
const minEdgeWeight = ref(1)
const selectedNode = ref<GraphNode | null>(null)

let chart: unknown = null
let echarts: unknown = null

async function loadECharts() {
  try {
    echarts = await import('echarts')
    return true
  } catch {
    return false
  }
}

async function buildGraph() {
  loading.value = true
  error.value = ''
  selectedNode.value = null
  try {
    const res = await window.electronAPI.buildGraph()
    if (!res.success) throw new Error((res.error as { message: string }).message)
    const { nodes: n, edges: e } = res.data as { nodes: GraphNode[]; edges: GraphEdge[] }
    nodes.value = n
    edges.value = e
    renderChart()
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

function renderChart() {
  if (!chartRef.value || !echarts || !nodes.value.length) return

  // Dispose previous
  if (chart) (echarts as { init: (el: HTMLElement) => unknown; getInstanceByDom: (el: HTMLElement) => unknown }).getInstanceByDom(chartRef.value) && (chart as { dispose: () => void }).dispose()
  chart = (echarts as { init: (el: HTMLElement) => unknown }).init(chartRef.value)

  const filteredEdges = edges.value.filter((e) => e.value >= minEdgeWeight.value)
  const usedNodes = new Set(filteredEdges.flatMap((e) => [e.source, e.target]))
  const visibleNodes = nodes.value.filter((n) => usedNodes.has(n.id) || n.value > 0)

  const maxVal = Math.max(...visibleNodes.map((n) => n.value), 1)

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      formatter: (params: { dataType: string; data: { name: string; questionCount?: number; docCount?: number; value: number } }) => {
        if (params.dataType === 'node') {
          return `<b>${params.data.name}</b><br/>题目: ${params.data.questionCount ?? 0}<br/>文档块: ${params.data.docCount ?? 0}`
        }
        return `共现: ${params.data.value} 次`
      }
    },
    series: [{
      type: 'graph',
      layout: 'force',
      animation: true,
      roam: true,
      label: { show: true, position: 'right', fontSize: 11, color: '#cbd5e1' },
      force: {
        repulsion: 200,
        gravity: 0.05,
        edgeLength: [80, 180],
        layoutAnimation: true,
      },
      lineStyle: { color: '#334155', width: 1, opacity: 0.6 },
      edgeSymbol: ['none', 'none'],
      emphasis: {
        focus: 'adjacency',
        lineStyle: { width: 2 },
      },
      nodes: visibleNodes.map((n) => ({
        id: n.id,
        name: n.name,
        questionCount: n.questionCount,
        docCount: n.docCount,
        value: n.value,
        symbolSize: Math.max(20, Math.min(60, 20 + (n.value / maxVal) * 40)),
        itemStyle: {
          color: n.questionCount > 0
            ? `rgba(29, 78, 216, ${0.4 + (n.questionCount / maxVal) * 0.6})`
            : '#334155',
          borderColor: '#60a5fa',
          borderWidth: 1,
        },
      })),
      edges: filteredEdges.map((e) => ({
        source: e.source,
        target: e.target,
        value: e.value,
        lineStyle: { width: Math.min(3, 1 + e.value * 0.5) },
      })),
    }]
  }

  ;(chart as { setOption: (opt: unknown) => void; on: (event: string, cb: (params: { dataType: string; data: GraphNode }) => void) => void }).setOption(option)
  ;(chart as { on: (event: string, cb: (params: { dataType: string; data: GraphNode }) => void) => void }).on('click', (params) => {
    if (params.dataType === 'node') {
      selectedNode.value = params.data as GraphNode
    }
  })
}

onMounted(async () => {
  const ok = await loadECharts()
  if (!ok) {
    error.value = 'ECharts 未安装，请运行: pnpm add echarts'
    return
  }
  await buildGraph()
})

onUnmounted(() => {
  if (chart) (chart as { dispose: () => void }).dispose()
})

watch(minEdgeWeight, renderChart)

function handleResize() {
  if (chart) (chart as { resize: () => void }).resize()
}
window.addEventListener('resize', handleResize)
onUnmounted(() => window.removeEventListener('resize', handleResize))
</script>

<template>
  <div class="graph-view">
    <div class="view-header">
      <h2 class="view-title">知识图谱</h2>
      <div class="controls">
        <label class="label-sm">最小共现次数</label>
        <input v-model.number="minEdgeWeight" type="number" min="1" max="10" class="num-input" />
        <button class="btn-primary" @click="buildGraph" :disabled="loading">
          {{ loading ? '构建中…' : '刷新图谱' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error-card">{{ error }}</div>

    <div class="graph-wrap">
      <div v-if="loading" class="loading-overlay">
        <div class="spinner"></div>
        <div>正在构建知识图谱…</div>
      </div>
      <div v-else-if="nodes.length === 0 && !error" class="empty-tip">
        <div style="font-size:40px;margin-bottom:8px">◈</div>
        <div>暂无知识图谱数据</div>
        <div style="font-size:12px;margin-top:4px;color:#64748b">先导入文档或添加题目（附知识点标签）</div>
      </div>
      <div v-else ref="chartRef" class="chart-container"></div>

      <!-- Selected node info -->
      <div v-if="selectedNode" class="node-info">
        <div class="node-name">{{ selectedNode.name }}</div>
        <div class="node-stats">
          <div class="stat-item"><span class="stat-val">{{ selectedNode.questionCount }}</span><span class="stat-label">题目数</span></div>
          <div class="stat-item"><span class="stat-val">{{ selectedNode.docCount }}</span><span class="stat-label">文档块</span></div>
        </div>
        <button class="close-node-btn" @click="selectedNode = null">✕</button>
      </div>
    </div>

    <!-- Stats bar -->
    <div class="stats-bar">
      <span>{{ nodes.length }} 个知识节点</span>
      <span>{{ edges.filter(e => e.value >= minEdgeWeight).length }} 条关联边</span>
    </div>
  </div>
</template>

<style scoped>
.graph-view { display: flex; flex-direction: column; gap: 12px; height: 100%; }
.view-header { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.view-title { font-size: 20px; font-weight: 700; color: #e2e8f0; flex: 1; }
.controls { display: flex; align-items: center; gap: 10px; }
.label-sm { font-size: 12px; color: #94a3b8; }
.num-input { background: #1e293b; border: 1px solid #475569; border-radius: 6px; color: #e2e8f0; padding: 5px 8px; width: 56px; font-size: 13px; }
.btn-primary { background: #1d4ed8; border: none; border-radius: 8px; color: #fff; padding: 8px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.error-card { background: #450a0a; border: 1px solid #f87171; border-radius: 8px; padding: 12px 16px; color: #f87171; font-size: 13px; }

.graph-wrap { flex: 1; position: relative; background: #1e293b; border: 1px solid #334155; border-radius: 10px; overflow: hidden; }
.chart-container { width: 100%; height: 100%; }

.loading-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #94a3b8; font-size: 14px; background: #1e293b; }
.spinner { width: 32px; height: 32px; border: 3px solid #334155; border-top-color: #60a5fa; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.empty-tip { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #475569; font-size: 13px; }

.node-info {
  position: absolute; bottom: 16px; left: 16px;
  background: rgba(15, 23, 42, 0.95); border: 1px solid #475569;
  border-radius: 10px; padding: 12px 16px; min-width: 160px;
  backdrop-filter: blur(4px);
}
.node-name { font-size: 14px; font-weight: 600; color: #e2e8f0; margin-bottom: 8px; }
.node-stats { display: flex; gap: 16px; }
.stat-item { display: flex; flex-direction: column; align-items: center; }
.stat-val { font-size: 20px; font-weight: 700; color: #60a5fa; }
.stat-label { font-size: 11px; color: #64748b; }
.close-node-btn { position: absolute; top: 8px; right: 8px; background: none; border: none; color: #64748b; cursor: pointer; font-size: 14px; }

.stats-bar { display: flex; gap: 16px; font-size: 12px; color: #475569; flex-shrink: 0; }
</style>
