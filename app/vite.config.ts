import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 子路徑部署；本機開發與其他平台自動用 '/'
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/groupbuy/' : '/',
  plugins: [react()],
}))
