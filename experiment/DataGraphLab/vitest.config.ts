import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 本套件含重 BFS（2M 节点预算）、Python 子进程训练与门禁并发触发，多线程并行会
    // 因 CPU/内存争用把 BFS 推过预算而误报「unhandled error」。单 fork 串行换确定性，
    // 速度损失换可复现——实验套件的正确性优先于墙钟时间。
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
