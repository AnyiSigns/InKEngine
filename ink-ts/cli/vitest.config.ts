import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // spawn e2e（node --import tsx 冷启 + host 装配）耗时，缺省放宽到 90s；
    // 单独较快的单元用例不受影响（实际耗时毫秒级）。
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
