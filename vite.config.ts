import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_BASE_URL || 'https://qa-app.beconversive.com'
  const convApiBase = env.VITE_CONV_API_BASE_URL || env.VITE_ADMIN_API_BASE_URL || 'https://qa-api.txtbox.in'
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: apiBase, changeOrigin: true, secure: true },
        '/v1': { target: apiBase, changeOrigin: true, secure: true },
        '/v2': { target: convApiBase, changeOrigin: true, secure: true },
      }
    }
  }
})
