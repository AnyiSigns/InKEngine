/**
 * 单点训练演示 CLI（D 表：main --n --seed --out，产 checkpoint + metrics.json）。
 *
 * 管道完全复用 eval/scale 的抽取函数（sampleTasks / buildSplitBin / runTrainer，
 * 不重写采样与 featurize）：N 条 train 骨架任务（style 50/50，E.13 只收 on-path
 * oracle）→ train.bin；val 固定集 `makeSplit('val', 200, seed)` → val.bin；真实
 * `controller/train.py`（spawnSync，`--save-last-k 5`）→ weights.json；再从
 * weights.train_meta 摘出 metrics.json（{final_val_ce, epochs_run, best_epoch,
 * arch, train_meta}）。stdout 打印一行 JSON 摘要；invokedDirectly 守卫下可直接
 * `npx tsx demos/train_demo.ts ...` 运行。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeSplit } from '../gen/generator.js';
import { readWeightsJson } from '../controller/checkpoint.js';
import type { Split } from '../schema.js';
import {
  PKG_ROOT,
  buildSplitBin,
  defaultTrainerPath,
  runTrainer,
  sampleTasks,
  skeletonPool,
} from '../eval/scale.js';

export interface TrainDemoOptions {
  readonly n: number;
  readonly seed: number;
  readonly out: string;
  readonly split: Split;
}

export interface TrainDemoResult {
  readonly weightsPath: string;
  readonly metricsPath: string;
  readonly arch: string;
  readonly finalValCe: unknown;
  readonly epochsRun: unknown;
  readonly bestEpoch: unknown;
  readonly n: number;
  readonly seed: number;
  readonly split: Split;
}

/** 训练 + 指标落盘；出参目录即 `--out`（自动创建）。 */
export function runTrainDemo(opts: TrainDemoOptions): TrainDemoResult {
  if (!Number.isInteger(opts.n) || opts.n < 1) throw new Error(`train_demo: --n 须为正整数（收到 ${String(opts.n)}）`);
  if (!Number.isInteger(opts.seed)) throw new Error(`train_demo: --seed 须为整数（收到 ${String(opts.seed)}）`);
  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const tasks = sampleTasks(opts.n, opts.seed, skeletonPool(opts.split), 0.5);
  const valTasks = makeSplit('val', 200, opts.seed);
  buildSplitBin(tasks, join(outDir, 'store_train'), join(outDir, 'train.bin'));
  buildSplitBin(valTasks, join(outDir, 'store_val'), join(outDir, 'val.bin'));
  const weightsPath = join(outDir, 'weights.json');
  runTrainer({
    trainer: defaultTrainerPath(),
    trainBin: join(outDir, 'train.bin'),
    valBin: join(outDir, 'val.bin'),
    outWeights: weightsPath,
    saveLastK: 5,
  });
  const file = readWeightsJson(weightsPath, { featureSet: 'lang' });
  const metrics = {
    final_val_ce: file.train_meta.final_val_ce ?? null,
    epochs_run: file.train_meta.epochs_run ?? null,
    best_epoch: file.train_meta.best_epoch ?? null,
    arch: file.arch,
    train_meta: file.train_meta,
  };
  const metricsPath = join(outDir, 'metrics.json');
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  return {
    weightsPath,
    metricsPath,
    arch: file.arch,
    finalValCe: metrics.final_val_ce,
    epochsRun: metrics.epochs_run,
    bestEpoch: metrics.best_epoch,
    n: opts.n,
    seed: opts.seed,
    split: opts.split,
  };
}

/** CLI 解析：`--n <int> --seed <int> --out <dir> [--split train]`；非法即抛。 */
export function parseArgs(argv: readonly string[]): TrainDemoOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const nRaw = get('--n') ?? '64';
  const seedRaw = get('--seed') ?? '0';
  const splitRaw = get('--split') ?? 'train';
  const n = Number(nRaw);
  const seed = Number(seedRaw);
  if (!Number.isInteger(n) || !Number.isInteger(seed)) {
    throw new Error(`train_demo: --n/--seed 必须是整数（收到 --n=${nRaw} --seed=${seedRaw}）`);
  }
  if (splitRaw !== 'train' && splitRaw !== 'val' && splitRaw !== 'heldout') {
    throw new Error(`train_demo: 非法 --split=${splitRaw}`);
  }
  return { n, seed, out: get('--out') ?? join(PKG_ROOT, 'runs', `train-demo-${String(seed)}`), split: splitRaw };
}

/** 入口包装（返回退出码）：成功打印一行 JSON 摘要（含 stdout 纪律）。 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    const res = runTrainDemo(parseArgs(argv));
    console.log(JSON.stringify({
      out: res.weightsPath,
      metrics: res.metricsPath,
      n: res.n,
      seed: res.seed,
      split: res.split,
      arch: res.arch,
      final_val_ce: res.finalValCe,
      epochs_run: res.epochsRun,
      best_epoch: res.bestEpoch,
    }));
    return 0;
  } catch (err) {
    console.error(`train_demo: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
