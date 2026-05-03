import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['firebase/app', 'firebase/firestore']
  },
  server: {
    proxy: {
      '/api': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/analyze/, '/v1/messages'),
        headers: {
          'x-api-key': process.env.VITE_ANTHROPIC_KEY || '',
          'anthropic-version': '2023-06-01'
        }
      }
    }
  }
})