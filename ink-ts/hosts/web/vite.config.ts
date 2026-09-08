import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// web 宿主产品壳构建/测试配置：产品 chrome 在 hosts/web/src（index.html + main.tsx
// + App + app/* 产品壳/视图），显示设备在 renderer/（@ink-ts/renderer 纯显示库）。
// 别名双根：`@/` = renderer/src 显示资产/数据面；`@app/` = 本包 src/app 产品壳
// （插件真 ui 面经 plugins 的 vitest 同构别名取用；改这两根须同步 plugins/
// vitest.config.ts 与各包 tsconfig paths）。dev server 的 /api 代理仅为本地
// 联调预留，生产通道 = cli serve http/ws（接真 serve 只换 transport 实现）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@app', replacement: fileURLToPath(new URL('./src/app/', import.meta.url)) },
      { find: '@', replacement: fileURLToPath(new URL('../../renderer/src/', import.meta.url)) },
    ],
  },
  server: {
    port: 5176,
    proxy: {
      '/api': 'http://127.0.0.1:8010',
    },
  },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // 全量并行下组件交互用例（userEvent）耗时可超默认 5s，放宽至 20s
    testTimeout: 20000,
    css: false,
  },
});
