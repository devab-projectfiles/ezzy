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
        // Dot, search bar and panel are three separate always-on-top windows (PLAN.md §6);
        // the toast is chunk E's fourth, and the only one that is click-through.
        input: {
          dot: resolve('src/renderer/dot.html'),
          searchbar: resolve('src/renderer/searchbar.html'),
          panel: resolve('src/renderer/panel.html'),
          toast: resolve('src/renderer/toast.html')
        }
      }
    },
    plugins: [react()]
  }
})
