<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import * as echarts from 'echarts'
import { usePlanStore } from '../stores/plan'
import { useLearningLogStore } from '../stores/learning-log'
import { useKnowledgeDomainStore } from '../stores/knowledge-domain'

const planStore = usePlanStore()
const logStore = useLearningLogStore()
const kdStore = useKnowledgeDomainStore()

// ─── Refs for chart containers ─────────────────────────────────────────────────
const heatmapRef = ref<HTMLDivElement | null>(null)
const radarRef = ref<HTMLDivElement | null>(null)
const trendRef = ref<HTMLDivElement | null>(null)

let heatmapChart: echarts.ECharts | null = null
let radarChart: echarts.ECharts | null = null
let trendChart: echarts.ECharts | null = null

// ─── Weakness data ─────────────────────────────────────────────────────────────
const weakTags = ref<Array<{ tag: string; rate: number; total: number }>>([])
const loading = ref(true)

// ─── Chart options ─────────────────────────────────────────────────────────────

function buildHeatmapOption(data: Array<[string, number]>) {
  return {
    tooltip: {
      formatter: (p: { data: [string, number] }) =>
        `${p.data[0]}<br/>完成率: ${Math.round(p.data[1] * 100)}%`,
    },
    visualMap: {
      min: 0,
      max: 1,
      type: 'piecewise' as const,
      orient: 'horizontal' as const,
      left: 'center',
      bottom: 0,
      pieces: [
        { min: 0.8, color: '#2d8c4a' },
        { min: 0.5, max: 0.8, color: '#73b87b' },
        { min: 0.2, max: 0.5, color: '#f4c344' },
        { max: 0.2, color: '#e8806c' },
      ],
    },
    calendar: {
      top: 20,
      left: 30,
      right: 30,
      cellSize: ['auto' as const, 15],
      range: new Date().getFullYear(),
      itemStyle: { borderWidth: 2, borderColor: 'var(--c-bg, #1a1a2e)' },
      dayLabel: { color: 'var(--c-text-2, #888)' },
      monthLabel: { color: 'var(--c-text-1, #ccc)' },
      yearLabel: { show: false },
    },
    series: [{
      type: 'heatmap',
      coordinateSystem: 'calendar',
      data,
    }],
  }
}

function buildRadarOption(indicators: Array<{ name: string; max: number }>, values: number[]) {
  return {
    tooltip: { formatter: (p: { value: number }) => `掌握度: ${Math.round(p.value * 100)}%` },
    radar: {
      indicator: indicators,
      center: ['50%', '55%'],
      radius: '65%',
      axisName: { color: 'var(--c-text-2, #888)' },
    },
    series: [{
      type: 'radar',
      data: [{ value: values, name: '掌握度', areaStyle: { color: 'rgba(74, 144, 226, 0.2)' } }],
      lineStyle: { color: '#4a90e2' },
      itemStyle: { color: '#4a90e2' },
    }],
  }
}

function buildTrendOption(
  dates: string[],
  focusData: number[],
  accuracyData: number[]
) {
  return {
    tooltip: { trigger: 'axis' as const },
    legend: {
      data: ['学习时长(分钟)', '正确率(%)'],
      textStyle: { color: 'var(--c-text-2, #888)' },
      top: 0,
    },
    grid: { left: 50, right: 50, top: 50, bottom: 30 },
    xAxis: {
      type: 'category' as const,
      data: dates,
      axisLabel: { color: 'var(--c-text-2, #888)', rotate: 45 },
    },
    yAxis: [
      {
        type: 'value' as const,
        name: '分钟',
        axisLabel: { color: 'var(--c-text-2, #888)' },
      },
      {
        type: 'value' as const,
        name: '%',
        max: 100,
        axisLabel: { color: 'var(--c-text-2, #888)' },
      },
    ],
    series: [
      {
        name: '学习时长(分钟)',
        type: 'line',
        data: focusData,
        smooth: true,
        itemStyle: { color: '#4a90e2' },
      },
      {
        name: '正确率(%)',
        type: 'line',
        yAxisIndex: 1,
        data: accuracyData,
        smooth: true,
        itemStyle: { color: '#2d8c4a' },
      },
    ],
  }
}

// ─── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  loading.value = true
  try {
    // Load stats
    if (planStore.activePlan) {
      await planStore.loadStats()
      // Calendar: load last 6 months
      const now = new Date()
      const heatData: Array<[string, number]> = []
      for (let m = 0; m < 6; m++) {
        const year = now.getFullYear()
        const month = now.getMonth() + 1 - m
        const adjYear = month <= 0 ? year - 1 : year
        const adjMonth = month <= 0 ? month + 12 : month
        try {
          await planStore.loadCalendar(adjYear, adjMonth)
          for (const d of planStore.calendarData) {
            heatData.push([d.date, d.total > 0 ? d.completed / d.total : 0])
          }
        } catch { /* skip months with no data */ }
      }

      if (heatmapChart && heatmapRef.value) {
        heatmapChart.setOption(buildHeatmapOption(heatData))
      }
    }

    // Radar: knowledge domain mastery
    await kdStore.loadTree()
    const l1Domains = kdStore.tree
    if (l1Domains.length > 0 && radarChart) {
      const indicators = l1Domains.map((d) => ({ name: d.name, max: 1 }))
      // Use tagAccuracy from plan stats to compute mastery per level-1 domain
      const values = l1Domains.map((domain) => {
        const childNames = collectChildNames(domain)
        const matchingStats = (planStore.stats?.tagAccuracy ?? []).filter(
          (t) => childNames.some((cn) => t.tag.includes(cn) || cn.includes(t.tag))
        )
        if (matchingStats.length === 0) return 0.5 // default
        const avg = matchingStats.reduce((s, t) => s + t.rate, 0) / matchingStats.length
        return Math.round(avg * 100) / 100
      })
      radarChart.setOption(buildRadarOption(indicators, values))
    }

    // Trend: last 30 days focus + accuracy
    await logStore.loadStats(30)
    const dates = logStore.dailyStats.map((s) => s.date.slice(5)) // MM-DD
    const focusData = logStore.dailyStats.map((s) => s.total_focus_minutes)
    // Accuracy per day (approximate from tagAccuracy)
    const accuracyData = logStore.dailyStats.map(() => {
      const tags = planStore.stats?.tagAccuracy ?? []
      return tags.length > 0
        ? Math.round((tags.reduce((s, t) => s + t.rate, 0) / tags.length) * 100)
        : 0
    })

    if (trendChart) {
      trendChart.setOption(buildTrendOption(dates, focusData, accuracyData))
    }

    // Weakness analysis
    const tags = planStore.stats?.tagAccuracy ?? []
    weakTags.value = [...tags]
      .filter((t) => t.total >= 5)
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 5)
  } finally {
    loading.value = false
  }
}

function collectChildNames(domain: { name: string; children: Array<{ name: string }> }): string[] {
  const names = [domain.name]
  for (const child of domain.children) {
    names.push(child.name)
  }
  return names
}

async function generateReinforcement(tag: string) {
  if (!planStore.activePlan) return
  try {
    await window.electronAPI.addCustomTask({
      planId: planStore.activePlan.id,
      task: {
        date: new Date().toISOString().slice(0, 10),
        knowledge_tag: tag,
        task_type: 'practice',
        estimated_min: 45,
        suggested_count: 15,
        priority: 2,
      },
    })
    await planStore.loadTodayTasks()
  } catch (e) {
    console.error('Failed to add reinforcement task:', e)
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await nextTick()

  if (heatmapRef.value) heatmapChart = echarts.init(heatmapRef.value)
  if (radarRef.value) radarChart = echarts.init(radarRef.value)
  if (trendRef.value) trendChart = echarts.init(trendRef.value)

  await loadData()

  const handleResize = () => {
    heatmapChart?.resize()
    radarChart?.resize()
    trendChart?.resize()
  }
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  heatmapChart?.dispose()
  radarChart?.dispose()
  trendChart?.dispose()
})
</script>

<template>
  <div class="stats-dashboard">
    <h1 class="page-title">学习统计仪表盘</h1>

    <div v-if="loading" class="loading">加载中...</div>

    <template v-else>
      <!-- Core Metrics -->
      <div class="metrics-row" v-if="planStore.activePlan">
        <div class="metric-card">
          <span class="metric-value">{{ planStore.stats?.streak ?? 0 }}</span>
          <span class="metric-label">连续学习天数</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{{ Math.round((planStore.stats?.totalStudyMs ?? 0) / 3600000) }}</span>
          <span class="metric-label">累计学习(小时)</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{{ planStore.stats?.tagAccuracy?.length ?? 0 }}</span>
          <span class="metric-label">已练习知识点</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{{ planStore.stats?.today.completed ?? 0 }}/{{ planStore.stats?.today.total ?? 0 }}</span>
          <span class="metric-label">今日完成</span>
        </div>
      </div>

      <!-- Charts Grid -->
      <div class="charts-grid">
        <!-- Calendar Heatmap -->
        <div class="chart-panel">
          <h3>学习日历热力图</h3>
          <div ref="heatmapRef" class="chart-container" style="height:220px"></div>
        </div>

        <!-- Radar Chart -->
        <div class="chart-panel">
          <h3>知识域掌握度雷达图</h3>
          <div ref="radarRef" class="chart-container" style="height:350px"></div>
        </div>

        <!-- Trend Chart -->
        <div class="chart-panel chart-panel--wide">
          <h3>学习趋势（近30天）</h3>
          <div ref="trendRef" class="chart-container" style="height:300px"></div>
        </div>

        <!-- Weakness Analysis -->
        <div class="chart-panel">
          <h3>薄弱知识域分析</h3>
          <div v-if="weakTags.length === 0" class="empty-hint">暂无足够数据</div>
          <div v-else class="weakness-list">
            <div
              v-for="(item, idx) in weakTags"
              :key="item.tag"
              class="weakness-item"
            >
              <span class="weakness-rank">#{{ idx + 1 }}</span>
              <span class="weakness-tag">{{ item.tag }}</span>
              <span class="weakness-rate" :class="{ low: item.rate < 0.4 }">
                {{ Math.round(item.rate * 100) }}%
              </span>
              <button class="btn-reinforce" @click="generateReinforcement(item.tag)">
                一键强化
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stats-dashboard {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.page-title {
  margin: 0 0 24px;
  font-size: 24px;
  color: var(--c-text-1, #e0e0e0);
}

.loading {
  text-align: center;
  padding: 60px;
  color: var(--c-text-2, #888);
  font-size: 16px;
}

/* Metrics */
.metrics-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.metric-card {
  background: var(--c-panel, #16213e);
  border: 1px solid var(--c-border, #2a3a5c);
  border-radius: 12px;
  padding: 20px;
  text-align: center;
}

.metric-value {
  display: block;
  font-size: 28px;
  font-weight: 700;
  color: #4a90e2;
  margin-bottom: 6px;
}

.metric-label {
  font-size: 13px;
  color: var(--c-text-2, #888);
}

/* Charts */
.charts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.chart-panel {
  background: var(--c-panel, #16213e);
  border: 1px solid var(--c-border, #2a3a5c);
  border-radius: 12px;
  padding: 20px;
}

.chart-panel--wide {
  grid-column: span 2;
}

.chart-panel h3 {
  margin: 0 0 16px;
  font-size: 16px;
  color: var(--c-text-1, #e0e0e0);
}

.chart-container {
  width: 100%;
}

.empty-hint {
  color: var(--c-text-2, #888);
  padding: 30px 0;
  text-align: center;
}

/* Weakness List */
.weakness-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.weakness-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--c-bg, #1a1a2e);
  border-radius: 8px;
}

.weakness-rank {
  font-size: 14px;
  font-weight: 600;
  color: #4a90e2;
  min-width: 28px;
}

.weakness-tag {
  flex: 1;
  font-size: 14px;
  color: var(--c-text-1, #e0e0e0);
}

.weakness-rate {
  font-size: 14px;
  font-weight: 600;
  color: #73b87b;
}

.weakness-rate.low {
  color: #e8806c;
}

.btn-reinforce {
  padding: 6px 14px;
  font-size: 12px;
  background: #4a90e2;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.2s;
}

.btn-reinforce:hover {
  background: #357abd;
}

/* Responsive */
@media (max-width: 768px) {
  .metrics-row {
    grid-template-columns: repeat(2, 1fr);
  }
  .charts-grid {
    grid-template-columns: 1fr;
  }
  .chart-panel--wide {
    grid-column: span 1;
  }
}
</style>
