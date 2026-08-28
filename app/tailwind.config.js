/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 霧藍主題：清透霧藍背景 + 深灰藍文字（UNIQLO/無印感）
        ink: {
          50: '#F0F5F9',  // 霧藍背景（原 #fafafa）
          100: '#E8EFF6', // 導覽/卡片淺底
          200: '#C8D9E8', // 邊框
          300: '#A8BECF',
          400: '#8AA0B5',
          500: '#6B7C8F', // muted 文字
          600: '#4A5E73',
          700: '#25364A', // 主文字
          800: '#1E3A5F', // 深灰藍 primary
          900: '#152A45',
          950: '#0F1F33',
        },
        // 主色：晴空藍 → 深灰藍（原活力橘 #ee4d2d 系）
        accent: {
          50: '#EFF5FA',
          100: '#E0ECF5',
          200: '#C8D9E8',
          300: '#A8C4DC',
          400: '#7AA6C8',
          500: '#5B8DBE', // 晴空藍主色
          600: '#3D6A99',
          700: '#2A4A6E',
          800: '#1E3A5F', // 深灰藍
          900: '#152A45',
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
