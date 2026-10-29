import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // 组件测试（.tsx）走 automatic JSX runtime，无需在每个文件里 import React
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@shared': resolvePath('./src/shared'),
      '@engine': resolvePath('./src/main/engine'),
    },
  },
  test: {
    // 引擎是纯 Node 模块（零 electron 依赖），因此默认 node 环境即可直测；
    // 组件测试在文件头用 `// @vitest-environment jsdom` 单独切环境
    environment: 'node',
    globals: true,
    // Tess 稍后才补测试，此刻 npm test 不能因此报错
    passWithNoTests: true,
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 20000,
    reporters: ['default'],
  },
});
