import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base 路徑：
//   - GitHub Pages（gh-pages 分支部署）需要 '/groupbuy/' 子路徑
//   - Vercel 是根路徑，用 '/' 即可
// 以 Vercel 環境變數自動判斷；本機開發也走 '/'
export default defineConfig(({ mode }) => ({
  base: process.env.VERCEL ? '/' : mode === 'production' ? '/groupbuy/' : '/',
  plugins: [react()],
}))
