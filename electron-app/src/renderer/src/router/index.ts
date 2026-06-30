import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/',           name: 'home',      component: () => import('../views/HomeView.vue') },
    { path: '/questions',  name: 'questions', component: () => import('../views/QuestionsView.vue') },
    { path: '/practice',   name: 'practice',  component: () => import('../views/PracticeView.vue') },
    { path: '/plans',      name: 'plans',     component: () => import('../views/PlansView.vue') },
    { path: '/ai',         name: 'ai',        component: () => import('../views/AiView.vue') },
    { path: '/documents',       name: 'documents',  component: () => import('../views/DocumentsView.vue') },
    { path: '/crawler',         name: 'crawler',    component: () => import('../views/CrawlerView.vue') },
    { path: '/knowledge-graph', name: 'graph',      component: () => import('../views/KnowledgeGraphView.vue') },
    { path: '/essay',           name: 'essay',      component: () => import('../views/EssayView.vue') },
    { path: '/pomodoro',        name: 'pomodoro',   component: () => import('../views/PomodoroView.vue') },
    { path: '/achievements',    name: 'achievements', component: () => import('../views/AchievementsView.vue') },
    { path: '/settings',        name: 'settings',   component: () => import('../views/SettingsView.vue') },
  ],
})

export default router
