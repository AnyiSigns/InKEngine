/**
 * discipline 门禁：代码纪律 gate。
 * 执行 gate/src/check.ts（行数/import/词汇/src-test/UTF-8 架构门禁），
 * 违规非零退出。覆盖 ink-ts 各包 src/test 目录。
 */

import { join } from 'node:path';

import type { GateResult } from '../_report.js';
import { runCommand } from '../_proc.js';
import type { SelfCheckContext } from '../index.js';

export async function runGateDiscipline(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const checkEntry = join(ctx.inkTsRoot, 'gate', 'src', 'check.ts');
  const out = await runCommand([process.execPath, '--import', 'tsx', checkEntry], {
    cwd: ctx.inkTsRoot,
    timeoutMs: 120_000,
  });
  const seconds = (Date.now() - started) / 1000;
  const passed = out.code === 0;
  const lines = out.stdout.split('\n').concat(out.stderr.split('\n')).filter((l) => l.trim() !== '');
  return {
    key: 'discipline',
    label: '代码纪律 gate',
    command: 'tsx gate/src/check.ts',
    passed,
    seconds,
    summary: passed ? '代码纪律 gate 全绿' : `违规 ${lines.filter((l) => l.includes('FAIL')).length} 处`,
    tail: lines,
  };
}
