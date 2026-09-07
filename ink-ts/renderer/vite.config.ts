import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// web 包构建/测试配置：测试 = vitest + jsdom + RTL（随迁 inkling/frontend
// 配置形态）；`@/` = src 路径别名（源码与测试共用）。dev server 的 /api 代理
// 仅为本地联调预留，生产通道 = cli serve http/ws（web 侧按 transport
// 接口接入，接真 serve 时只换 transport 实现，本配置不动）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5176,
    proxy: {
      '/api': 'http://127.0.0.1:8010',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // 全量并行下组件交互用例（userEvent）耗时可超默认 5s，放宽至 20s
    testTimeout: 20000,
    css: false,
  },
});
