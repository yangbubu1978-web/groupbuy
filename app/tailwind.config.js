/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 奶油韓系：暖奶白背景 + 可可棕文字（韓國咖啡廳感）
        ink: {
          50: '#FFFBF5',  // 奶油背景
          100: '#FFF5EB', // 淺奶油
          200: '#E8DDD0', // 燕麥邊框
          300: '#D6C4B0',
          400: '#BBA693',
          500: '#9C8B7A', // muted
          600: '#7A6B5A',
          700: '#4A3F35', // 主文字（可可棕黑）
          800: '#2C2420',
          900: '#1A1612',
          950: '#0F0D0A',
        },
        // 主色：奶茶棕 → 焦糖（溫暖韓系）
        accent: {
          50: '#FFF8F0',
          100: '#F5E6D3',
          200: '#E8DDD0',
          300: '#D6BFA8',
          400: '#C9A87A', // 奶茶
          500: '#B8935F', // 焦糖主色
          600: '#A67C52',
          700: '#8B5E34',
          800: '#6B4423',
          900: '#4A2E18',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"Noto Sans TC"',
          '"PingFang TC"', '"Microsoft JhengHei"', 'sans-serif',
        ],
        display: [
          '-apple-system', 'BlinkMacSystemFont', '"Noto Sans TC"',
          '"PingFang TC"', '"Microsoft JhengHei"', 'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}
