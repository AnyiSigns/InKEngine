/**
 * bench 门禁：启动/回合耗时最小基准。
 * 度量 serve 冷启动到 listen 行、以及一轮 stub 回合往返的毫秒耗时，
 * 超过宽松上限即失败（冷启动受 tsx 首载影响，上限放 60s；回合 30s）。
 * 提供真实耗时数字，供回归对比。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { GateResult } from '../_report.js';
import { firstJsonLine, killTree, spawnLong } from '../_proc.js';
import type { SelfCheckContext } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ink-self-check-bench-'));
}

export async function runGateBench(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const cliEntry = join(ctx.inkTsRoot, 'cli', 'src', 'index.ts');
  const token = `self-check-bench-${randomBytes(6).toString('hex')}`;
  const child = spawnLong([process.execPath, '--import', 'tsx', cliEntry, 'serve', '--port', '0', '--data-dir', tempDir(), '--token', token], {
    cwd: ctx.inkTsRoot,
    timeoutMs: 60_000,
  });
  try {
    const listenAt = Date.now();
    const line = (await firstJsonLine(child, 60_000)) as unknown as { url?: string; token?: string };
    const bootMs = Date.now() - listenAt;
    if (typeof line.url !== 'string' || typeof line.token !== 'string') {
      return { key: 'bench', label: '启动/回合耗时基准', command: 'serve', passed: false, seconds: (Date.now() - started) / 1000, summary: 'serve 未输出 listen 行', tail: [JSON.stringify(line)] };
    }
    const roundStart = Date.now();
    const round = await fetch(`${line.url}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'rounds.send',
        params: { input: 'self-check-bench', trace_id: `self-check-bench-${Date.now()}` },
      }),
    });
    const roundJson = (await round.json()) as { result?: { reply?: string }; error?: unknown };
    const roundMs = Date.now() - roundStart;
    const bootOk = bootMs <= 60_000;
    const roundOk = round.status === 200 && roundJson.error === undefined && roundMs <= 30_000;
    const seconds = (Date.now() - started) / 1000;
    const tail: string[] = [];
    if (!roundOk) tail.push(`/rpc ${round.status} ${JSON.stringify(roundJson)}`);
    return {
      key: 'bench',
      label: '启动/回合耗时基准',
      command: 'serve 冷启动 + stub 回合',
      passed: bootOk && roundOk,
      seconds,
      summary: `serve 冷启动 ${bootMs}ms / stub 回合 ${roundMs}ms${bootOk && roundOk ? '（达标）' : '（超限）'}`,
      tail,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { key: 'bench', label: '启动/回合耗时基准', command: 'serve', passed: false, seconds: (Date.now() - started) / 1000, summary: `异常: ${message}`, tail: [message] };
  } finally {
    killTree(child.proc);
    await child.waitClose(5_000);
  }
}
