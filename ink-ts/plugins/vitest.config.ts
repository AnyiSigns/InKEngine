import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// plugins 根 vitest 配置：插件测试随插件同住（faces/ 内 *.test.{ts,tsx}）。
// ui 面测试（faces/ui/**）走 jsdom + RTL（react 插件转译）；faces/logic 等
// 纯 TS 测试保持 node 环境。`@` 别名指向 renderer/src（共享显示资产/数据层/
// 产品壳类型，随插件 faces 复用——阶段 7b 真面化；外部分发插件改包出口）。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../renderer/src', import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    environment: 'node',
    globals: true,
    setupFiles: ['../renderer/test/setup.ts'],
    environmentMatchGlobs: [['**/faces/ui/**', 'jsdom']],
    include: ['**/*.test.{ts,tsx}'],
    // ui 面组件交互用例（userEvent）可超默认 5s，放宽至 20s
    testTimeout: 20000,
    css: false,
  },
});
