import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'

// Global image load error logger — helps debug missing images (especially exam-image:// protocol)
window.addEventListener('error', (e) => {
  const target = e.target
  if (target instanceof HTMLImageElement) {
    console.warn('[ImgError] Failed to load:', target.src, '(naturalWidth:', target.naturalWidth, ')')
  }
}, true) // capture phase to catch errors on dynamically inserted <img> elements

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
