/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 台灣電商風「白底灰階」：純白/淺灰底 → 近黑文字
        ink: {
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#09090b',
        },
        // 主色：蝦皮式活力橘（下殺、促銷、CTA）
        accent: {
          50: '#fff4f1',
          100: '#ffe5de',
          200: '#fecabb',
          300: '#fda691',
          400: '#fa7b5e',
          500: '#ee4d2d',
          600: '#dc3e1d',
          700: '#b72f14',
          800: '#922712',
          900: '#772512',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"Noto Sans TC"',
          '"PingFang TC"', '"Microsoft JhengHei"', 'sans-serif',
        ],
        // 電商風全站黑體（display 不再用襯線）
        display: [
          '-apple-system', 'BlinkMacSystemFont', '"Noto Sans TC"',
          '"PingFang TC"', '"Microsoft JhengHei"', 'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}
