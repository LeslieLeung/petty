import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: false,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  optimizeDeps: {
    // Pre-bundle Tauri API modules so the first open of any window
    // doesn't trigger a Vite dep-optimization reload.
    include: ['@tauri-apps/api/core', '@tauri-apps/api/event', '@tauri-apps/api/window'],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
      },
    },
  },
})
