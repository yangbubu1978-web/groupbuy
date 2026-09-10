/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 日系生活感 · 鮮嫩版（更飽和的柿子橘 + 米白）
        ink: {
          50: '#FFFBF5',
          100: '#FFF5EB',
          200: '#E8DDD0',
          300: '#D6C4B0',
          400: '#BBA693',
          500: '#9C8B7A',
          600: '#7A6B5A',
          700: '#4A3F35',
          800: '#2C2420',
          900: '#1A1612',
          950: '#0F0D0A',
        },
        accent: {
          50: '#FFF2EB',
          100: '#FFD9C2',
          200: '#FFB899',
          300: '#FF8F66',
          400: '#FF7A45',
          500: '#FF6B35', // 鮮嫩柿子橘（更飽和）
          600: '#E85A28',
          700: '#C94A1E',
          800: '#9A3816',
          900: '#6B2610',
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
