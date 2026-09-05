/**
 * vitest 门禁：各包 vitest 全量（gate/cli/engine/host/web）。
 * 逐个以 vitest run --root <pkg> 执行，汇总退出码；web 包无独立
 * vitest.config.ts，以 vite.config.ts 的 test 块承接（同 root test 语义）。
 */

import { join } from 'node:path';

import type { GateResult } from '../_report.js';
import { runCommand } from '../_proc.js';
import type { SelfCheckContext } from '../index.js';

const PACKAGES = ['gate', 'cli', 'engine', 'host', 'web'] as const;

export async function runGateVitest(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const vitestCli = join(ctx.inkTsRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const summaries: string[] = [];
  const tails: string[] = [];
  let passed = true;
  for (const pkg of PACKAGES) {
    const out = await runCommand([process.execPath, vitestCli, 'run', '--root', pkg], {
      cwd: ctx.inkTsRoot,
      timeoutMs: 30 * 60_000,
    });
    const ok = out.code === 0;
    passed = passed && ok;
    const lastLines = out.stdout
      .split('\n')
      .concat(out.stderr.split('\n'))
      .map((l) => l.trim())
      .filter((l) => /Test Files|Tests |Duration|Unhandled|FAIL|Error/.test(l))
      .slice(-4);
    const testLine = lastLines.find((l) => /Tests\s+\d/.test(l)) ?? lastLines.find((l) => /Test Files/.test(l)) ?? '';
    summaries.push(`${pkg}: ${ok ? 'PASS' : 'FAIL'}` + (testLine ? ` ${testLine}` : ''));
    if (!ok) {
      tails.push(`[${pkg}] 退出码 ${out.code ?? '超时'}`);
      tails.push(...lastLines);
    }
  }
  const seconds = (Date.now() - started) / 1000;
  return {
    key: 'vitest',
    label: '各包 vitest（gate/cli/engine/host/web）',
    command: 'vitest run --root <gate|cli|engine|host|web>',
    passed,
    seconds,
    summary: summaries.join('；'),
    tail: tails,
  };
}
