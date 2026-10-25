import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const resolvePath = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // 渲染层在 src/renderer 下（Max-2 的领地），产物统一出到 dist/renderer
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolvePath('./src/shared'),
      '@': resolvePath('./src/renderer'),
    },
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
