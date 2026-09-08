/**
 * 停掉 live 常驻 serve（与 run_live.ts 的 LIVE_PORT/LIVE_TOKEN 成对）。
 *
 * run_live.ts 首次运行时 spawn 的 serve 常驻（detached），供后续运行复用端口
 * 避免重复装配；本脚本显式收停（`--force-spawn` 重装配前亦可先用本脚本旧进程）。
 *
 * 实现：读固定端口上的监听进程 PID（NetTCPConnection 等价物——用 lsof/ps 跨平台，
 * Windows 走 `netstat -ano` + `taskkill`），SIGTERM/终止。
 */

import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVE_ENTRY = path.join(ROOT, 'bootstrap', 'main.ts');

const LIVE_PORT = 18740;

function pidsOnPort(port: number): string[] {
  try {
    // Windows netstat -ano：`TCP  127.0.0.1:18740 ... LISTENING  1234`
    const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' });
    const lines = out.split('\n').filter((l) => l.includes(`:${port}`) && /LISTENING/i.test(l));
    return [...new Set(lines.map((l) => l.trim().split(/\s+/).pop() ?? '').filter((s) => /^\d+$/.test(s)))];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const pids = pidsOnPort(LIVE_PORT);
  if (pids.length === 0) {
    process.stdout.write(`live serve 未在 127.0.0.1:${LIVE_PORT} 监听（无需停止）\n`);
    return;
  }
  for (const pid of pids) {
    const resolved = String(pid).replace(/\s/g, '');
    if (resolved === '' || resolved === '0') continue;
    try {
      process.kill(Number(resolved), 'SIGTERM');
    } catch {
      try {
        execFileSync('taskkill', ['/PID', resolved, '/F', '/T']);
      } catch {
        // 已退出或无权限
      }
    }
    process.stdout.write(`已终止 live serve pid=${resolved}\n`);
  }
}

// 避免被杀进程是当前脚本自身（CJK 注释防误解）；仅执行一次
void __dirname;
void ROOT;
void SERVE_ENTRY;
void randomUUID;
main().catch((err) => {
  process.stderr.write(`[live:stop] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
