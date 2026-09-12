import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base 路徑：
//   - Vercel 部署在網域根目錄，用 '/' 即可；本機開發（dev）也走 '/'
//   - 歷史遺留：原本部署在 GitHub Pages（子路徑 /groupbuy/），該站已停用
//     （gh-pages 分支不存在、舊網址 404）。但「本機 npm run build」沒有 VERCEL
//     環境變數，仍會產生 '/groupbuy/' 前綴 —— 這是已知的本地/線上差異。
//     ⚠️ 判斷線上是否為同一份 build 時，不要比對 index.html 的路徑字串，
//        請比對 CSS 的 sha256（CSS 不含 base，兩邊一定相同）。
export default defineConfig(({ mode }) => ({
  base: process.env.VERCEL ? '/' : mode === 'production' ? '/groupbuy/' : '/',
  plugins: [react()],
}))
