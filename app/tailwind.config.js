/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 日系霧藍 · UI UX Pro Max 優化版
        // 靈感：Soft UI Evolution + Hero-Centric + 信任感電商
        ink: {
          50: '#F0F5F9',  // 霧藍背景
          100: '#E8EFF6',
          200: '#C8D9E8', // 邊框
          300: '#A8BECF',
          400: '#8AA0B5',
          500: '#6B7C8F',
          600: '#4A5E73',
          700: '#25364A', // 主文字（對比 7:1）
          800: '#1E3A5F',
          900: '#152A45',
          950: '#0F1F33',
        },
        accent: {
          50: '#EFF5FA',
          100: '#E0ECF5',
          200: '#C8D9E8',
          300: '#A8C4DC',
          400: '#7AA6C8',
          500: '#5B8DBE', // 晴空藍 CTA
          600: '#3D6A99',
          700: '#2A4A6E',
          800: '#1E3A5F', // 深灰藍 primary
          900: '#152A45',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"Noto Sans TC"',
          '"PingFang TC"', '"Microsoft JhengHei"', 'sans-serif',
        ],
        display: [
          '"Shippori Mincho"', '"Noto Serif TC"', 'serif',
        ],
      },
      boxShadow: {
        'soft': '0 6px 24px rgba(30,58,95,.08)',
        'soft-lg': '0 10px 36px rgba(30,58,95,.12)',
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '20px',
      },
    },
  },
  plugins: [],
}
