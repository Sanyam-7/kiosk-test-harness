import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_BASE_URL || 'https://qa-app.beconversive.com'
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: apiBase, changeOrigin: true, secure: true },
        '/v1': { target: apiBase, changeOrigin: true, secure: true },
      }
    }
  }
})
