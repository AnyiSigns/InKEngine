/**
 * G0.1 生成确定性（docs/gates.md G0.1）：
 * ① 同参 makeTask 在两个独立子进程各生成一批 `task_hash`（spawnSync 起 tsx
 *    跑 g01_worker.ts，Windows 下 tsx 入口取 node_modules 内 cli.mjs 绝对路径，
 *    不依赖 PATH），两份输出与父进程内存复算三路比对、逐字节一致 →
 *    `hash_match_ratio` 必须 == 1；
 * ② 冻结 fixture 的 makeRng/crc32/canonicalJson 全部用例复算比对 → 命中数
 *    必须等于用例数。不内联任何期望数字：期望全部来自 fixture 冻结值。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, crc32, hashObj } from '../../world/hash.js';
import { makeRng } from '../../world/rng.js';
import { buildResult, memoized, type GateContext, type GateResult } from './common.js';
import { buildHashLine, G01_CASES } from './g01_worker.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(dirname(HERE));
const TSX_CLI = join(PKG_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WORKER = join(HERE, 'g01_worker.ts');

const VERSION = 1;

function runWorker(): string {
  if (!existsSync(TSX_CLI) || !existsSync(WORKER)) {
    throw new Error(`g01: 子进程入口缺失（tsx=${String(existsSync(TSX_CLI))} worker=${String(existsSync(WORKER))}）`);
  }
  const proc = spawnSync(process.execPath, [TSX_CLI, WORKER], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (proc.error !== undefined) throw new Error(`g01: 子进程启动失败: ${proc.error.message}`);
  if (proc.status !== 0) throw new Error(`g01: 子进程退出码 ${String(proc.status)}: ${proc.stderr.trim()}`);
  return proc.stdout;
}

function firstDiffIndex(a: string, b: string): number {
  try {
    const xa = JSON.parse(a) as unknown[];
    const xb = JSON.parse(b) as unknown[];
    for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
      if (canonicalJson(xa[i]) !== canonicalJson(xb[i])) return i;
    }
    return -1;
  } catch {
    return 0;
  }
}

function fixtureRecompute(ctx: GateContext): { matched: number; total: number } {
  let matched = 0;
  let total = 0;
  for (const fx of ctx.fixtures.rng) {
    total++;
    const r = makeRng(fx.seed);
    const got = Array.from({ length: fx.first8.length }, () => r.next());
    if (canonicalJson(got) === canonicalJson(fx.first8)) matched++;
  }
  for (const fx of ctx.fixtures.crc32) {
    total++;
    if (crc32(fx.s) === fx.crc32) matched++;
  }
  for (const fx of ctx.fixtures.canonical) {
    total++;
    // canonical 段冻结的是规范串（-0 与 0 在 JSON 里同串，复算按规范串回读即等价）。
    const value: unknown = JSON.parse(fx.json);
    if (canonicalJson(value) === fx.json && hashObj(value) === fx.hash) matched++;
  }
  return { matched, total };
}

function compute(ctx: GateContext): GateResult {
  const outA = runWorker();
  const outB = runWorker();
  const self = buildHashLine(G01_CASES);
  const allSame = self === outA && self === outB;
  const diff = allSame ? -1 : firstDiffIndex(outA, outB);
  const { matched, total } = fixtureRecompute(ctx);
  const notes = allSame
    ? `子进程×2 + 本进程内存复算三路逐字节同串；fixture ${String(total)} 例复算全命中；全链无 Math.random/内置 hash`
    : `三路上任两路输出不一致（outA/outB 首个差异位置 ${String(diff)}）`;
  return buildResult({
    gate: 'G0.1',
    version: VERSION,
    ctx,
    seeds: [...G01_CASES.map((c) => c.seed), ...ctx.fixtures.rng.map((r) => r.seed)],
    metrics: {
      hash_match_ratio: allSame ? 1 : 0,
      process_case_count: G01_CASES.length,
      fixture_match_count: matched,
      fixture_case_count: total,
    },
    thresholds: {
      'hash_match_ratio:eq': 1,
      'process_case_count:min': 1,
      'fixture_match_count:eq': total,
      'fixture_case_count:min': 1,
    },
    notes,
  });
}

/** 公开入口：子进程复算昂贵，同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G0.1', ctx, () => compute(ctx));
}
