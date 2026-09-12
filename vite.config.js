import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/cellsphere/',
  plugins: [vue()],
  build: {
    outDir: 'docs',
    emptyOutDir: false,
  },
})
