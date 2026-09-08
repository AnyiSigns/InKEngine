/**
 * 启动 live 常驻 serve（供 live/run_live.ts 复用端口，避免每次重装配）。
 *
 * 前台运行：本进程保持 serve 长驻，监听固定端口（18740）+ 固定 token，
 * 与 run_live.ts 的 LIVE_PORT/LIVE_TOKEN 成对。run_live.ts 直接探测该端口，
 * host.ping 鉴权通过即复用——不重新 createHost、不重装配模型链。
 *
 * 用法：npx tsx live/serve_live.ts（Ctrl+C 停止；或 live/stop_live.ts）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runServe } from '../hosts/cli/src/serve.js';
import { parseArgs } from '../hosts/cli/src/argv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, '.dev-data/kilo-cli');
const LIVE_PORT = 18740;
const LIVE_TOKEN = 'ink-ts-live-loopback';

async function main(): Promise<void> {
  const argv = ['serve', '--port', String(LIVE_PORT), '--token', LIVE_TOKEN, '--data-dir', CONFIG_DIR];
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`[live:serve] ${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`[live:serve] 常驻 serve 监听 127.0.0.1:${LIVE_PORT}（token=${LIVE_TOKEN}）\n`);
  await runServe(parsed.options, { stdout: process.stdout, stderr: process.stderr });
}

main().catch((err) => {
  process.stderr.write(`[live:serve] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
