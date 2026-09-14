import type { Config } from 'tailwindcss';

/**
 * 莫兰迪色板:低饱和灰调。
 * brand=灰绿(sage)· blush=灰粉 · sand=燕麦灰 · ink=暖调深灰(侧栏)
 * 语义色同步灰化:good=灰绿 warn=灰金 bad=灰红。
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f4f6f3',
          100: '#e7ebe4',
          200: '#cfd8cc',
          300: '#adbcaa',
          400: '#93a492',
          500: '#82907f',
          600: '#6f7c6d',
          700: '#5c675b',
          800: '#4c544b',
          900: '#3f453e',
          DEFAULT: '#6f7c6d',
        },
        blush: {
          50: '#f8f3f1',
          100: '#f0e6e3',
          200: '#e4cfc9',
          300: '#d5b5ac',
          400: '#c6a094',
          500: '#b58c7f',
          600: '#9c7266',
          700: '#825b52',
          DEFAULT: '#b58c7f',
        },
        sand: {
          50: '#f8f6f1',
          100: '#efe9dd',
          200: '#e2d8c6',
          300: '#d2c3a9',
          400: '#c0ad8c',
          500: '#a8956f',
          DEFAULT: '#c0ad8c',
        },
        ink: {
          950: '#26251f',
          900: '#2f2d26',
          800: '#3a3730',
          700: '#4a463b',
        },
        good: {
          50: '#f1f4ee',
          100: '#e0e8da',
          DEFAULT: '#7f8d72',
          600: '#6a775d',
        },
        warn: {
          50: '#f8f3e8',
          100: '#efe3cb',
          DEFAULT: '#c2a26b',
          600: '#a5854f',
        },
        bad: {
          50: '#f8efee',
          100: '#f0dcd9',
          DEFAULT: '#b98b84',
          600: '#9f6f67',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(60,55,45,.05), 0 1px 3px rgba(60,55,45,.07)',
        'card-hover': '0 4px 12px rgba(60,55,45,.1), 0 2px 4px rgba(60,55,45,.05)',
        glow: '0 0 0 1px rgba(173,188,170,.18), 0 0 40px rgba(147,164,146,.16)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        'float-slow': {
          '0%, 100%': { transform: 'translateY(0) scale(1)' },
          '50%': { transform: 'translateY(-14px) scale(1.03)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '.55' },
        },
        'grow-w': {
          '0%': { width: '0%' },
        },
      },
      animation: {
        'fade-up': 'fade-up .5s cubic-bezier(.22,1,.36,1) both',
        'fade-in': 'fade-in .4s ease both',
        shimmer: 'shimmer 1.4s linear infinite',
        'float-slow': 'float-slow 9s ease-in-out infinite',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
        'grow-w': 'grow-w .9s cubic-bezier(.22,1,.36,1) both',
      },
    },
  },
  plugins: [],
};
export default config;
