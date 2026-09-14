import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // docs/01 §6:青蓝色系(区别于竞品紫罗兰),语义色自成体系
        brand: {
          50: '#ecfeff',
          100: '#cffafe',
          200: '#a5f3fc',
          300: '#67e8f9',
          400: '#22d3ee',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
          800: '#155e75',
          900: '#164e63',
          DEFAULT: '#0891b2',
        },
        ink: {
          950: '#0a0f1e',
          900: '#101728',
          800: '#1a2338',
          700: '#2a3550',
        },
        good: '#059669',
        warn: '#d97706',
        bad: '#dc2626',
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06)',
        'card-hover': '0 4px 12px rgba(16,24,40,.08), 0 2px 4px rgba(16,24,40,.04)',
        glow: '0 0 0 1px rgba(103,232,249,.15), 0 0 40px rgba(34,211,238,.15)',
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
