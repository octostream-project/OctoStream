import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@octostream/exo-player': path.resolve(projectRoot, 'capacitor-plugins/exoplayer/dist/esm/index.js'),
      '@octostream/youtube': path.resolve(projectRoot, 'capacitor-plugins/youtube/dist/esm/index.js'),
      '@octostream/torrent-engine': path.resolve(projectRoot, 'capacitor-plugins/torrent-engine/dist/esm/index.js'),
      '@optopus/sync-server': path.resolve(projectRoot, 'capacitor-plugins/sync-server/src/index.js'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  // Elimina console.log/debug/info del bundle de producción (hay ~250 llamadas,
  // incluyendo hot loops por segmento HLS y por stream resuelto). En WebViews
  // de TV cada console.* tiene coste real de serialización. Se conservan
  // console.warn y console.error.
  // NOTA: Vite 8 usa rolldown+oxc — `esbuild.pure` se ignora; el equivalente
  // es treeshake.manualPureFunctions.
  build: {
    rolldownOptions: {
      treeshake: {
        manualPureFunctions: ['console.log', 'console.debug', 'console.info'],
      },
    },
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@capacitor/')) return 'capacitor'
          if (id.includes('/node_modules/react') ||
              id.includes('/node_modules/react-dom') ||
              id.includes('/node_modules/react-router-dom') ||
              id.includes('/node_modules/zustand')) return 'vendor'
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
})
