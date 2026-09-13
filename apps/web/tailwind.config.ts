import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // docs/01 §6:青蓝色系主色(区别于竞品紫罗兰),语义色自成体系
        brand: { DEFAULT: '#0891b2', fg: '#ecfeff', muted: '#67e8f9' },
        good: '#059669',
        warn: '#d97706',
        bad: '#dc2626',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;
