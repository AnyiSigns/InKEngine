/**
 * 演示数据生成 CLI（D 表：main --n --seed --out，产 JSONL 行数==n）。
 *
 * 混合口径选定为 C.8 的 50/50 比例固定版：第 i 条任务 style = i%2（follow/goal
 * 严格轮转），family 交给 `makeTask` 按 style 默认池随机（同一 rng 内确定性）；
 * 不用 makeTask 的默认 style 轮转，因为 scaling 协议明文「报告须固定比例」。
 * 每条 Task 用 `canonicalJson` 规范序列化写一行（键序稳定），落盘后仍完整可读回
 * 为 Task 并用 `taskHash` 复算——Task 侧隐藏字段（plan_hidden/expected）留在
 * 本产物里供 oracle/G0.2 使用；轨迹步记录（records.jsonl）由 data/store.ts 另存。
 *
 * 用法：`npx tsx demos/generate_demo.ts --n 20 --seed 3 --out runs/demo_tasks.jsonl`；
 * `--out` 是文件路径（缺省 `<包根>/runs/demo_tasks.jsonl`），父目录自动创建；
 * 失败（n 非法/生成不出任务）退出码非 0，成功打印统计行。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../world/hash.js';
import { makeTask } from '../gen/generator.js';
import { type Task } from '../schema.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface DemoOptions {
  readonly n: number;
  readonly seed: number;
  readonly out: string;
}

export interface DemoResult {
  readonly path: string;
  readonly count: number;
}

/** `makeTask` 可能整体失败（重试耗尽）；沿 attempt 推进派生 seed，仍失败即显式抛错。 */
export function buildTasks(n: number, seed: number): Task[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`generate_demo: --n 必须为正整数（收到 ${String(n)}）`);
  }
  if (!Number.isInteger(seed)) {
    throw new Error(`generate_demo: --seed 必须为整数（收到 ${String(seed)}）`);
  }
  const out: Task[] = [];
  for (let i = 0; i < n; i++) {
    const style = i % 2 === 0 ? 'follow' : 'goal';
    let task: Task | null = null;
    for (let attempt = 0; attempt < 32 && task === null; attempt++) {
      task = makeTask(seed + i * 1000 + attempt * 100003, style);
    }
    if (task === null) {
      throw new Error(`generate_demo: 第 ${String(i)} 条任务在 32 次重试内无法产出（style=${style}）`);
    }
    out.push(task);
  }
  return out;
}

/** 覆盖写 JSONL（每行一条 canonical Task）；行数==n 由调用方断言。 */
export function runGenerateDemo(opts: DemoOptions): DemoResult {
  const tasks = buildTasks(opts.n, opts.seed);
  const path = resolve(opts.out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, tasks.map((t) => `${canonicalJson(t)}\n`).join(''), 'utf8');
  return { path, count: tasks.length };
}

/** 读回 Task JSONL：逐行 parse + 必填字段校验（外部边界 fail-fast，不静默降级）。 */
export function loadDemoTasks(path: string): Task[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    let raw: Partial<Task> | null = null;
    try {
      raw = JSON.parse(line) as Partial<Task>;
    } catch {
      throw new Error(`loadDemoTasks: 第 ${String(i)} 行不是合法 JSON`);
    }
    for (const field of [
      'style',
      'family',
      'instruction',
      'x',
      'spec',
      'expected',
      'plan_hidden',
      'root',
      'plan_hash',
      'composition_id',
      'split',
    ] as const) {
      if (raw[field] === undefined) {
        throw new Error(`loadDemoTasks: 第 ${String(i)} 行缺 Task 字段 ${field}`);
      }
    }
    return raw as Task;
  });
}

/** CLI 解析：`--n <int> --seed <int> --out <path>`；非法参数抛错（main 转非 0 退出码）。 */
export function parseArgs(argv: readonly string[]): DemoOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const nRaw = get('--n') ?? '10';
  const seedRaw = get('--seed') ?? '0';
  const n = Number(nRaw);
  const seed = Number(seedRaw);
  if (!Number.isInteger(n) || !Number.isInteger(seed)) {
    throw new Error(`generate_demo: --n/--seed 必须是整数（收到 --n=${nRaw} --seed=${seedRaw}）`);
  }
  return { n, seed, out: get('--out') ?? join(PKG_ROOT, 'runs', 'demo_tasks.jsonl') };
}

/** 入口包装（返回退出码）：库调用方直接拿返回值，CLI 壳落 process.exitCode。 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const opts = parseArgs(argv);
    const res = runGenerateDemo(opts);
    console.log(`generate_demo: wrote ${String(res.count)} tasks -> ${res.path}`);
    return 0;
  } catch (err) {
    console.error(`generate_demo: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
