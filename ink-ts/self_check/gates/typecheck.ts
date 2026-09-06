/**
 * typecheck 门禁：engine 包全量类型检查（tsc -p engine/tsconfig.json）。
 * generated 数据面常量以 `satisfies readonly (...)` 约束 schema 枚举，satisfies
 * 生效点必须在 tsc 全量下验证（vitest 走 esbuild/tsx 不做类型检查），故出厂
 * 自检链显式带 engine typecheck。
 */

import { join } from 'node:path';

import type { GateResult } from '../_report.js';
import { runCommand } from '../_proc.js';
import type { SelfCheckContext } from '../index.js';

export async function runGateTypecheck(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const tsc = join(ctx.inkTsRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const out = await runCommand(
    [process.execPath, tsc, '-p', join(ctx.inkTsRoot, 'engine', 'tsconfig.json')],
    { cwd: ctx.inkTsRoot, timeoutMs: 120_000 },
  );
  const seconds = (Date.now() - started) / 1000;
  const passed = out.code === 0;
  const tail = out.stdout.split('\n').concat(out.stderr.split('\n')).filter((l) => l.trim() !== '').slice(-30);
  return {
    key: 'typecheck',
    label: 'engine 全量类型检查',
    command: 'tsc -p engine/tsconfig.json',
    passed,
    seconds,
    summary: passed ? 'engine tsc 全绿（generated satisfies 生效）' : `engine tsc 失败（exit ${out.code ?? '超时'}）`,
    tail,
  };
}
