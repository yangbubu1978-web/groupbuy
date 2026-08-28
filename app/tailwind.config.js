/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 日系生活感 · 活潑（zakka / 北歐日雜感）
        // 米紙白 + 木質棕 + 朱紅活力點綴
        ink: {
          50: '#FFFBF5',  // 米紙白背景
          100: '#F9F1E7', // 淺米
          200: '#E8DDD0', // 邊框
          300: '#D6C4B0',
          400: '#BBA693',
          500: '#9C8B7A',
          600: '#7A6B5A',
          700: '#4A3F35', // 木質棕主文字
          800: '#2C2420',
          900: '#1A1612',
          950: '#0F0D0A',
        },
        accent: {
          50: '#FFF0EC',
          100: '#FFD9CC',
          200: '#FFB8A0',
          300: '#FF8A6B',
          400: '#F26B4A',
          500: '#E85D3F', // 朱紅主色（鳥居/印章感）
          600: '#C94A2E',
          700: '#A33A22',
          800: '#7A2E1B',
          900: '#552515',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"Noto Sans TC"',
          '"PingFang TC"', '"Microsoft JhengHei"', 'sans-serif',
        ],
        display: [
          '"Zen Maru Gothic"', '"Noto Sans TC"', 'sans-serif',
        ],
      },
      boxShadow: {
        'soft': '0 6px 24px rgba(74,63,53,.08)',
        'soft-lg': '0 10px 36px rgba(74,63,53,.12)',
      },
    },
  },
  plugins: [],
}
