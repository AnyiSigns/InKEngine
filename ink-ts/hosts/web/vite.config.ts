import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// web 宿主产品壳构建/测试配置：产品 chrome 在 hosts/web/src（index.html + main.tsx
// + App + app/* 产品壳/视图），显示设备在 renderer/（@ink-ts/renderer 纯显示库）。
// 别名双根：`@/` = renderer/src 显示资产/数据面；`@app/` = 本包 src/app 产品壳
// （插件真 ui 面经 plugins 的 vitest 同构别名取用；改这两根须同步 plugins/
// vitest.config.ts 与各包 tsconfig paths）。

// —— dev serve 自动拉起（免双终端/免 .env）——
// web 经 cli serve http/ws 取数；dev 下本插件自动 spawn
// bootstrap/main.ts serve（回环固定端口 + dev token），并把 URL/token 注入
// process.env（Vite 对 VITE_* 前缀最高优先，import.meta.env 即达 transport），
// 语义等价旧 VITE_SERVE_URL/VITE_SERVE_TOKEN .env 维护。已显式设 serve 环境
// （外部 serve 联调/生产）时不拉起、不覆盖。
const DEV_SERVE_PORT = 18731;
const DEV_SERVE_TOKEN = 'ink-ts-dev-loopback';
const SERVE_URL_ENV = 'VITE_SERVE_URL';
const SERVE_TOKEN_ENV = 'VITE_SERVE_TOKEN';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const bootstrapEntry = fileURLToPath(new URL('../../bootstrap/main.ts', import.meta.url));

let serveChild: ChildProcess | null = null;

function stopDevServe(): void {
  if (serveChild === null) return;
  try {
    serveChild.kill();
  } catch {
    // 已退出
  }
  serveChild = null;
}

function spawnDevServe(): void {
  stopDevServe();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', bootstrapEntry, 'serve', '--port', String(DEV_SERVE_PORT), '--token', DEV_SERVE_TOKEN],
    { cwd: repoRoot, stdio: 'inherit', windowsHide: true },
  );
  serveChild = child;
  child.on('exit', (code) => {
    if (serveChild === child) serveChild = null;
    if (code !== 0) {
      console.error(
        `[vite:serve] serve 退出码 ${code}（端口 ${DEV_SERVE_PORT} 占用或启动失败）；` +
          `如需外部 serve：先设 ${SERVE_URL_ENV} 再重启 dev`,
      );
    }
  });
}

const autoServePlugin = {
  name: 'ink-ts-auto-serve',
  apply: 'serve' as const,
  configureServer(server: { config: { mode: string }; httpServer: { on(event: string, listener: () => void): unknown } | null }) {
    if (server.config.mode !== 'development') return;
    spawnDevServe();
    server.httpServer?.on('close', stopDevServe);
    process.once('exit', stopDevServe);
  },
};

export default defineConfig(({ command, mode }) => {
  if (command === 'serve' && mode === 'development' && !process.env[SERVE_URL_ENV]) {
    process.env[SERVE_URL_ENV] = `http://127.0.0.1:${DEV_SERVE_PORT}`;
    process.env[SERVE_TOKEN_ENV] = DEV_SERVE_TOKEN;
  }
  return {
    plugins: [react(), tailwindcss(), autoServePlugin],
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
  };
});
