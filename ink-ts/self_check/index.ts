/**
 * ink-ts 出厂等价自检编排（TS 版）：单个 tsx 命令跑通全部门禁并矩阵化汇报。
 *
 * 语义随迁自 inkling/self_check（Rust 七门禁）的等价物，面向 TS 工作区：
 * - contracts：contracts fixtures↔generated 权威性校验（verify_generated）；
 * - vitest：各包（gate/cli/engine/host/web）vitest 全量；
 * - discipline：代码纪律 gate（gate/src/check.ts，行数/import/词汇/src-test）；
 * - data：seed_data 与 contracts fixtures 数据一致性核（事件/工具/端点）；
 * - e2e：接线 e2e（spawn cli serve → /health + ws 订阅到事件帧）；
 * - bench：启动/回合耗时最小基准（serve 冷启动→listen→一轮 stub 回合）；
 * - symbols：符号引用计数最小等价（engine core 顶层导出孤儿扫描）。
 *
 * 用法：`node --import tsx self_check/index.ts all`（默认 all）；
 * 可指定子集：`contracts vitest discipline data e2e bench symbols`。
 * 任一失败非零退出。共享面（root npm script 挂接）不在此处改动，由
 * 仓库层统一接入；本编排可直接以 tsx 运行，不依赖额外安装。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GateResult } from './_report.js';
import { renderMatrix } from './_report.js';
import { runGateContracts } from './gates/contracts.js';
import { runGateVitest } from './gates/vitest.js';
import { runGateDiscipline } from './gates/discipline.js';
import { runGateData } from './gates/data.js';
import { runGateE2e } from './gates/e2e.js';
import { runGateBench } from './gates/bench.js';
import { runGateSymbols } from './gates/symbols.js';

export interface SelfCheckContext {
  /** ink-ts 工作区根（package.json name=ink-ts 所在目录）。 */
  inkTsRoot: string;
  /** 仓库根（AGENTS.md 所在目录；旧侧引用点）。 */
  repoRoot: string;
}

const here = dirname(fileURLToPath(import.meta.url));

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 找到 ink-ts 根与仓库根：self_check 位于 ink-ts 下，向上各找标记文件。 */
export function resolveRoots(start: string): SelfCheckContext {
  let dir = start;
  let inkTsRoot = '';
  for (;;) {
    const pkgText = readOptional(join(dir, 'package.json'));
    if (pkgText !== null) {
      try {
        const parsed = JSON.parse(pkgText) as { name?: string; workspaces?: string[] };
        if (parsed.name === 'ink-ts' && Array.isArray(parsed.workspaces) && parsed.workspaces.includes('engine')) {
          inkTsRoot = dir;
          break;
        }
      } catch {
        // 向上继续找
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (inkTsRoot === '') throw new Error('未找到 ink-ts 工作区根（package.json name=ink-ts）');
  let cursor = dirname(inkTsRoot);
  let repoRoot = inkTsRoot;
  for (;;) {
    if (readOptional(join(cursor, 'AGENTS.md')) !== null) {
      repoRoot = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { inkTsRoot, repoRoot };
}

const GATES: ReadonlyArray<{ key: string; label: string; run: (ctx: SelfCheckContext) => Promise<GateResult> }> = [
  { key: 'contracts', label: 'contracts fixtures↔generated', run: runGateContracts },
  { key: 'vitest', label: '各包 vitest（gate/cli/engine/host/web）', run: runGateVitest },
  { key: 'discipline', label: '代码纪律 gate', run: runGateDiscipline },
  { key: 'data', label: '数据一致性核（seed↔contracts）', run: runGateData },
  { key: 'e2e', label: '接线 e2e（serve→health+ws）', run: runGateE2e },
  { key: 'bench', label: '启动/回合耗时基准', run: runGateBench },
  { key: 'symbols', label: '符号引用计数', run: runGateSymbols },
];

export function gateKeys(): readonly string[] {
  return GATES.map((g) => g.key);
}

async function main(): Promise<void> {
  const ctx = resolveRoots(here);
  const args = process.argv.slice(2);
  const wanted = args.length === 0 || args.includes('all') ? gateKeys() : args.filter((a) => gateKeys().includes(a));
  const labels = new Map(GATES.map((g) => [g.key, g.label]));
  console.log(`ink-ts 出厂等价自检｜ink-ts: ${ctx.inkTsRoot}`);
  if (args.length > 0 && wanted.length === 0) {
    console.error(`未知门禁: ${args.join(' ')}（可选: ${gateKeys().join(' ')}）`);
    process.exitCode = 2;
    return;
  }
  const results: GateResult[] = [];
  for (const key of wanted) {
    const gate = GATES.find((g) => g.key === key)!;
    const result = await gate.run(ctx);
    results.push(result);
    console.log(`== 门禁 ${labels.get(key)}（${key}）: ${result.passed ? 'PASS' : 'FAIL'}`);
    console.log(`   耗时 ${result.seconds.toFixed(1)}s ｜ ${result.summary}`);
    if (!result.passed) {
      for (const line of result.tail.slice(-30)) console.log(`   | ${line}`);
    }
  }
  console.log(`\n${renderMatrix(results)}`);
  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.error(`\n自检未全绿：${failed.map((r) => r.key).join('、')}`);
    process.exitCode = 1;
  } else {
    console.log('\n自检全绿');
  }
}

await main();
