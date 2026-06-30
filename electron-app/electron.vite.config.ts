import { resolve } from 'path'
import { cpSync, mkdirSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'

function copyMigrationsPlugin(): Plugin {
  return {
    name: 'copy-sql-migrations',
    closeBundle() {
      const src  = resolve(__dirname, 'src/main/db/migrations')
      const dest = resolve(__dirname, 'out/main/migrations')
      mkdirSync(dest, { recursive: true })
      cpSync(src, dest, { recursive: true })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMigrationsPlugin()],
    resolve: { alias: { '@main': resolve('src/main') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src'),
      },
    },
    plugins: [vue()],
  },
})
