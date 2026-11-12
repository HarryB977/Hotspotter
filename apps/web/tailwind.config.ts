import type { Config } from 'tailwindcss';
import colors from 'tailwindcss/colors';

// Neutral zinc palette plus a single amber accent (docs/05-ui.md, section Estilo visual).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: colors.white,
      black: colors.black,
      zinc: colors.zinc,
      red: colors.red,
      green: colors.green,
      amber: colors.amber,
      accent: { DEFAULT: '#f59e0b' },
    },
    fontSize: {
      xs: ['11px', '16px'],
      sm: ['12px', '16px'],
      base: ['12px', '16px'],
      lg: ['14px', '20px'],
    },
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      borderRadius: { DEFAULT: '2px', sm: '2px', md: '3px' },
    },
  },
  plugins: [],
} satisfies Config;
