<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { useAppStore } from '../stores/app'

const route = useRoute()
const appStore = useAppStore()

const navItems = [
  { to: '/',          icon: '⊞', label: '仪表盘' },
  { to: '/questions', icon: '☰', label: '题库'   },
  { to: '/practice',  icon: '✎', label: '练习'   },
  { to: '/plans',     icon: '📅', label: '学习计划' },
  { to: '/ai',        icon: '✦', label: 'AI助手'  },
  { to: '/documents',       icon: '📄', label: '文档库'  },
  { to: '/crawler',         icon: '🕷', label: '爬虫'    },
  { to: '/knowledge-graph', icon: '◈',  label: '知识图谱' },
  { to: '/essay',           icon: '✍', label: '论文写作' },
  { to: '/settings',        icon: '⚙', label: '设置'   },
]
</script>

<template>
  <div class="shell" :class="{ dark: appStore.darkMode }">
    <!-- Left sidebar -->
    <nav class="sidebar">
      <div class="brand">软考</div>
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :class="{ active: route.path === item.to }"
      >
        <span class="nav-icon">{{ item.icon }}</span>
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <!-- Main area -->
    <div class="main">
      <!-- Top bar -->
      <header class="topbar">
        <div class="status-dot-wrap">
          <span class="status-dot" :class="appStore.pythonReady ? 'ok' : 'warn'" />
          <span class="status-text">{{ appStore.pythonReady ? 'Python 就绪' : 'Python 启动中…' }}</span>
        </div>
        <div class="topbar-right">
          <span class="db-badge" :class="appStore.dbReady ? 'ok' : 'warn'">
            DB v{{ appStore.dbVersion }}
          </span>
          <button class="dark-toggle" @click="appStore.toggleDarkMode">
            {{ appStore.darkMode ? '☀' : '☾' }}
          </button>
        </div>
      </header>

      <!-- Route content -->
      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: #0f172a;
  color: #e2e8f0;
}
.sidebar {
  width: 56px;
  display: flex;
  flex-direction: column;
  background: #1e293b;
  border-right: 1px solid #334155;
  transition: width 0.2s;
  overflow: hidden;
}
.sidebar:hover {
  width: 180px;
}
.brand {
  padding: 16px 0;
  text-align: center;
  font-weight: 700;
  font-size: 14px;
  color: #60a5fa;
  white-space: nowrap;
  overflow: hidden;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  text-decoration: none;
  color: #94a3b8;
  font-size: 13px;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: #334155; color: #e2e8f0; }
.nav-item.active { background: #1d4ed8; color: #fff; }
.nav-icon { font-size: 18px; flex-shrink: 0; width: 24px; text-align: center; }
.nav-label { opacity: 0; transition: opacity 0.15s; }
.sidebar:hover .nav-label { opacity: 1; }

.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  height: 44px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
  flex-shrink: 0;
}
.status-dot-wrap { display: flex; align-items: center; gap: 8px; }
.status-dot {
  width: 8px; height: 8px; border-radius: 50%;
}
.status-dot.ok   { background: #4ade80; }
.status-dot.warn { background: #f59e0b; animation: blink 1s ease-in-out infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
.status-text { font-size: 12px; color: #94a3b8; }
.topbar-right { display: flex; align-items: center; gap: 12px; }
.db-badge {
  font-size: 11px; padding: 2px 8px; border-radius: 4px;
  font-family: monospace;
}
.db-badge.ok   { background: #14532d; color: #4ade80; }
.db-badge.warn { background: #451a03; color: #f59e0b; }
.dark-toggle {
  background: none; border: 1px solid #475569; color: #94a3b8;
  width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 14px;
  display: flex; align-items: center; justify-content: center;
}
.dark-toggle:hover { border-color: #94a3b8; color: #e2e8f0; }
.content { flex: 1; overflow: auto; padding: 24px; }
</style>
