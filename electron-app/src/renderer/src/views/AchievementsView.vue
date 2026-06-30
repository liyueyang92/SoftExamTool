<script setup lang="ts">
import { onMounted, computed } from 'vue'
import { useAchievementStore } from '../stores/achievement'

const ach = useAchievementStore()

onMounted(() => {
  ach.load()
  ach.check()
})

const unlocked = computed(() => ach.achievements.filter((a) => a.unlocked_at != null))
const locked = computed(() => ach.achievements.filter((a) => a.unlocked_at == null))

function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
</script>

<template>
  <div class="ach-view">
    <h2 class="page-title">成就系统</h2>

    <!-- Summary -->
    <div class="summary-bar">
      <div class="summary-item">
        <span class="summary-num">{{ unlocked.length }}</span>
        <span class="summary-lbl">已解锁</span>
      </div>
      <div class="progress-bar-wrap">
        <div
          class="progress-bar-fill"
          :style="{ width: ach.totalCount() ? `${(ach.unlockedCount() / ach.totalCount()) * 100}%` : '0%' }"
        />
      </div>
      <div class="summary-item">
        <span class="summary-num">{{ ach.totalCount() }}</span>
        <span class="summary-lbl">总计</span>
      </div>
    </div>

    <!-- Unlocked achievements -->
    <div v-if="unlocked.length > 0" class="section">
      <h3 class="section-title">已解锁 ({{ unlocked.length }})</h3>
      <div class="badge-grid">
        <div v-for="a in unlocked" :key="a.id" class="badge-card unlocked">
          <div class="badge-icon">{{ a.icon }}</div>
          <div class="badge-title">{{ a.title }}</div>
          <div class="badge-desc">{{ a.desc }}</div>
          <div class="badge-date">{{ formatDate(a.unlocked_at!) }}</div>
        </div>
      </div>
    </div>

    <!-- Locked achievements -->
    <div v-if="locked.length > 0" class="section">
      <h3 class="section-title">待解锁 ({{ locked.length }})</h3>
      <div class="badge-grid">
        <div v-for="a in locked" :key="a.id" class="badge-card locked">
          <div class="badge-icon locked-icon">{{ a.icon }}</div>
          <div class="badge-title locked-text">{{ a.title }}</div>
          <div class="badge-desc locked-text">{{ a.desc }}</div>
          <div class="badge-date locked-text">尚未解锁</div>
        </div>
      </div>
    </div>

    <div v-if="ach.loading" class="loading">加载中…</div>
    <div v-else-if="ach.achievements.length === 0" class="empty">暂无成就数据</div>

    <div class="hint-card">
      <p>成就在以下操作后自动检测：完成练习、完成番茄钟、导入文档。也可点击"刷新检测"手动触发。</p>
      <button class="btn-outline" @click="ach.check()">刷新检测</button>
    </div>
  </div>
</template>

<style scoped>
.ach-view { display: flex; flex-direction: column; gap: 24px; }
.page-title { font-size: 22px; font-weight: 700; color: #e2e8f0; }

.summary-bar {
  background: #1e293b; border: 1px solid #334155; border-radius: 12px;
  padding: 16px 20px; display: flex; align-items: center; gap: 16px;
}
.summary-item { display: flex; align-items: baseline; gap: 6px; flex-shrink: 0; }
.summary-num { font-size: 28px; font-weight: 700; color: #fbbf24; }
.summary-lbl { font-size: 12px; color: #64748b; }
.progress-bar-wrap { flex: 1; height: 8px; background: #334155; border-radius: 4px; overflow: hidden; }
.progress-bar-fill { height: 100%; background: linear-gradient(90deg, #fbbf24, #f59e0b); border-radius: 4px; transition: width 0.4s; }

.section { display: flex; flex-direction: column; gap: 12px; }
.section-title { font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; }

.badge-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.badge-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 12px;
  padding: 16px; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
  transition: transform 0.15s;
}
.badge-card.unlocked { border-color: #fbbf24; box-shadow: 0 0 12px rgba(251,191,36,0.15); }
.badge-card.unlocked:hover { transform: translateY(-2px); }
.badge-icon { font-size: 36px; }
.locked-icon { filter: grayscale(1) opacity(0.4); }
.badge-title { font-size: 13px; font-weight: 700; color: #e2e8f0; }
.badge-desc { font-size: 11px; color: #94a3b8; }
.badge-date { font-size: 10px; color: #4ade80; }
.locked-text { color: #334155 !important; }

.loading, .empty { color: #64748b; font-size: 14px; text-align: center; padding: 40px; }

.hint-card {
  background: #1e293b; border: 1px solid #334155; border-radius: 12px;
  padding: 16px 20px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
}
.hint-card p { font-size: 13px; color: #64748b; flex: 1; }
.btn-outline {
  background: none; border: 1px solid #475569; border-radius: 8px; color: #94a3b8;
  padding: 8px 16px; font-size: 13px; cursor: pointer; flex-shrink: 0;
}
.btn-outline:hover { border-color: #94a3b8; color: #e2e8f0; }
</style>
