/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 露娜設計 · 高檔有機美妝（深苔綠＋暖米白＋香檳金）2026-09-10
        // accent: 深苔綠 Botanical Green（主色，CTA/價格/漸層全吃這組）
        // ink: 暖米系中性色（底色 Rice White #FAF7F1，文字深綠黑）
        // gold: 香檳金點綴（淺金只做線框/邊框，寫字用深古銅 700）
        ink: {
          50: '#FAF7F1',
          100: '#F1EAE0',
          200: '#E4D9C8',
          300: '#D2C2AC',
          400: '#B3A48E',
          500: '#8A7E6B',
          600: '#6B6154',
          700: '#4A4234',
          800: '#2C2721',
          900: '#1A2521',
          950: '#0F1513',
        },
        accent: {
          50: '#EEF4F0',
          100: '#DCE8DF',
          200: '#B9D2C2',
          300: '#8AB5A0',
          400: '#3E7A64',
          500: '#2E5B4A', // 主按鈕底（白字對比 7.7）
          600: '#1E3D34', // 深苔綠主色（白字對比 11.85）
          700: '#173129',
          800: '#12261F',
          900: '#0E1E19',
        },
        gold: {
          100: '#F8F0DC',
          200: '#EEDFB8',
          300: '#E2C98E',
          400: '#D4B46F',
          500: '#C9A96A', // 香檳金（只做線/邊框，不做字色）
          600: '#A9894F',
          700: '#7A6234', // 深古銅（可做字色，白底對比 5.79）
        },
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"Noto Sans TC"',
          '"PingFang TC"', '"Microsoft JhengHei"', 'sans-serif',
        ],
        display: [
          '"Noto Serif TC"', '"Noto Sans TC"', 'serif',
        ],
        'serif-en': [
          '"Cormorant Garamond"', '"Noto Serif TC"', 'serif',
        ],
      },
      boxShadow: {
        'soft': '0 6px 24px rgba(30,61,52,.08)',
        'soft-lg': '0 10px 36px rgba(30,61,52,.12)',
      },
    },
  },
  plugins: [],
}
