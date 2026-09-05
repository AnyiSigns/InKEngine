/**
 * contracts 门禁：fixtures↔generated 权威性校验。
 * 执行 contracts/scripts/verify_generated.mjs，重生成产物与仓库内生成物
 * 逐文件归一化比较，一致才通过。
 */

import { join } from 'node:path';

import type { GateResult } from '../_report.js';
import { runCommand } from '../_proc.js';
import type { SelfCheckContext } from '../index.js';

export async function runGateContracts(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const script = join(ctx.inkTsRoot, 'contracts', 'scripts', 'verify_generated.mjs');
  const out = await runCommand([process.execPath, script], { cwd: ctx.inkTsRoot, timeoutMs: 120_000 });
  const seconds = (Date.now() - started) / 1000;
  const passed = out.code === 0;
  return {
    key: 'contracts',
    label: 'contracts fixtures↔generated',
    command: 'node contracts/scripts/verify_generated.mjs',
    passed,
    seconds,
    summary: passed
      ? 'src/generated 与重生成产物一致'
      : `退出码 ${out.code ?? '超时'}：generated 被手改或生成器漂移`,
    tail: out.stdout.split('\n').concat(out.stderr.split('\n')).filter((l) => l.trim() !== ''),
  };
}
