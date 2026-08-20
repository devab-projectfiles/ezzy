import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        // The dot and the panel are separate always-on-top windows (PLAN.md §5, §6).
        input: {
          dot: resolve('src/renderer/dot.html'),
          panel: resolve('src/renderer/panel.html')
        }
      }
    },
    plugins: [react()]
  }
})
