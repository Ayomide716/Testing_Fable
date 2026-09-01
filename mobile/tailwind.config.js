/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Dark-mode-first palette. `void` is the app backdrop; the neons are
        // used only as accents and edges, never as large fills.
        void: '#05060B',
        surface: '#0B0E17',
        neon: {
          cyan: '#22D3EE',
          violet: '#A78BFA',
          amber: '#FCD34D',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
