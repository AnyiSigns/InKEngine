/**
 * C.8 数据 scaling 协议编排（公开面收敛本文件）。
 *
 * 钉死的两条纪律（与 `train.py` 的 `bc_train` 内外同一口径）：
 * - greedy pass@1 每题一次（§11.3），全部经由 `eval/metrics.passAt1` /
 *   `eval/arms.evaluateArm` 唯一实现，本文件不重写任何环境循环；
 * - 训练集只含 on-path oracle 标签（E.13）——任务 → `oracleTrace` → `recordFromStep`
 *   → store append/load → `featurizeRecords`，`plan_bfs` 永不进训练管线（只在
 *   held-out 侧作为公开规划臂的评测信号）。
 *
 * 流程（C.8 逐条对应）：val 固定集（seed=0）→ held-out 覆盖集（sanity，只报计数，
 * 主指标不消费）+ 统计集（主指标）→ 每 (N,seed) 采样 N 条 train 骨架任务 →
 * `.bin` → `controller/train.py`（spawnSync，`--save-last-k`）→ 末 K 快照+最终
 * params 在 val 上按 greedy pass@1 选终点 → held-out 全臂评测落长表 → 跨 seed
 * 幂律拟合 → k% 覆盖度副轴 → `results.{json,csv}`（协议契约 c8-v1）。
 *
 * 确定性：一切随机 `makeRng(seed)`；产物固定落 `runs/<runId>/`（每 run 独占
 * store 子目录），除 `generated_at` 时间戳外不混入任何非确定量。`trainer` 指
 * 向 `.py` 桩脚本时为测试通道（用默认解释器执行桩），指向解释器时走真实
 * `controller/train.py`。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { makeCoverageSplitInfo, makeSplit } from '../gen/generator.js';
import { worldVersion } from '../world/version.js';
import { taskHash, type Style } from '../schema.js';
import { GRAPH } from '../runner/graph.js';
import { rollout } from '../runner/rollout.js';
import { readWeightsJson } from '../controller/checkpoint.js';
import { defaultArms, evaluateArm } from './arms.js';
import { pathExcess, routingAcc, stepsOverShortest } from './metrics.js';
import { safeActionConflictRate } from '../data/provenance.js';
import {
  PKG_ROOT,
  buildSplitBin,
  defaultHeldoutPerFamily,
  defaultTrainerPath,
  oracleRecords,
  runTrainer,
  sampleTasks,
  skeletonPool,
  stamp,
} from './scale_pipes.js';
import {
  fitPowerLaw,
  metaNumber,
  selectCheckpoint,
  writeScaleResults,
  type CheckpointRow,
  type KcRow,
  type PowerFit,
  type ResultMeta,
  type ScalePoint,
  type ScaleReport,
} from './scale_report.js';
import { runCoverageAxis } from './coverage_axis.js';

export const DEFAULT_GRID: readonly number[] = [100, 300, 1000, 3000, 10000, 30000];
export const DEFAULT_SEEDS: readonly number[] = [0, 1, 2, 3, 4];
export const DEFAULT_COVERAGE_KS: readonly number[] = [10, 25, 50, 75, 100];
/** C.8 统计集配额上限（防 held-out 反超训练 N）。 */
export const HELDOUT_CAP = 300;

export interface ScaleOptions {
  readonly grid?: number[];
  readonly seeds?: number[];
  readonly outRoot?: string;
  readonly runId?: string;
  readonly trainer?: string;
  readonly trainPyArgs?: string[];
  readonly valPerFamily?: number;
  readonly heldoutCap?: number;
  readonly heldoutPerFamily?: number;
  readonly styleRatio?: number;
  readonly saveLastK?: number;
  readonly pythonTimeoutMs?: number;
  readonly coverageKs?: number[];
  readonly coverageN?: number;
  readonly includeKCoverage?: boolean;
}

/** 每 (N,seed) 的采样派生 seed：乘法散列保证跨格互不相同且可复现。 */
function cellSeed(n: number, seed: number): number {
  return (Math.imul(seed + 1, 2654435761) ^ Math.imul(n + 1, 40503)) >>> 0;
}

function validateInts(xs: readonly number[], label: string): void {
  for (const v of xs) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`runScale: ${label} 含非法值 ${String(v)}`);
  }
}

export function runScale(opts: ScaleOptions = {}): ScaleReport {
  const grid = opts.grid ?? [...DEFAULT_GRID];
  const seeds = opts.seeds ?? [...DEFAULT_SEEDS];
  validateInts(grid, 'grid');
  if (seeds.some((s) => !Number.isInteger(s) || s < 0)) throw new Error('runScale: seeds 须为非负整数');
  const styleRatio = opts.styleRatio ?? 0.5;
  const valPerFamily = opts.valPerFamily ?? 200;
  const heldoutCap = opts.heldoutCap ?? HELDOUT_CAP;
  const heldoutPerFamily = opts.heldoutPerFamily ?? defaultHeldoutPerFamily(heldoutCap);
  const saveLastK = opts.saveLastK ?? 5;
  const trainer = opts.trainer ?? defaultTrainerPath();
  const timeoutMs = opts.pythonTimeoutMs ?? 0;
  const coverageKs = opts.coverageKs ?? [...DEFAULT_COVERAGE_KS];
  const coverageN = opts.coverageN ?? (grid.length > 0 ? Math.max(...grid) : 3000);
  const includeKCoverage = opts.includeKCoverage !== false;

  const runId = opts.runId ?? `scale-${stamp()}`;
  const outRoot = opts.outRoot ?? join(PKG_ROOT, 'runs');
  const runDir = join(outRoot, runId);
  mkdirSync(runDir, { recursive: true });

  // —— val 固定集（C.8：VAL_SKELETONS，seed=0，与 held-out 零重叠）——
  const valTasks = makeSplit('val', valPerFamily, 0);
  const valBin = join(runDir, 'val.bin');
  buildSplitBin(valTasks, join(runDir, 'store', 'val'), valBin);

  // —— held-out：覆盖集（sanity）+ 统计集（主指标）——
  const cov = makeCoverageSplitInfo('heldout', 0);
  const statTasks = makeSplit('heldout', heldoutPerFamily, 0);
  const statRecords = oracleRecords(statTasks);

  const trainPool = skeletonPool('train');
  const rows: ScalePoint[] = [];
  const checkpoints: CheckpointRow[] = [];
  const trainedOf = (n: number, seed: number): string => join(runDir, `trained_N${String(n)}_s${String(seed)}`);

  for (const n of grid) {
    for (const seed of seeds) {
      // 采样 + on-path oracle → bin
      const tasks = sampleTasks(n, cellSeed(n, seed), trainPool, styleRatio);
      const trainBin = `${trainedOf(n, seed)}.bin`;
      buildSplitBin(tasks, join(runDir, 'store', `train_N${String(n)}_s${String(seed)}`), trainBin);
      // 训练（train.py 内外两层同一口径；失败即抛，不降级）
      const weights = `${trainedOf(n, seed)}_weights.json`;
      runTrainer({ trainer, trainBin, valBin, outWeights: weights, saveLastK, extraArgs: opts.trainPyArgs, timeoutMs });
      // 末 K 快照 + 最终 params 按 val greedy pass@1 选终点（并列取更晚）
      const file = readWeightsJson(weights);
      const selectedEpoch = selectCheckpoint(file, valTasks, saveLastK);
      checkpoints.push({
        N: n,
        seed,
        selected_snapshot_epoch: selectedEpoch.selectedSnapshotEpoch,
        final_val_ce: metaNumber(file.train_meta, 'final_val_ce'),
        best_val_pass1: selectedEpoch.bestValPass1,
      });
      // held-out 全臂 × 两 style
      for (const style of ['follow', 'goal'] as const) {
        const subset = statTasks.filter((t) => t.style === style);
        for (const arm of defaultArms(seed, selectedEpoch.policy)) {
          const rep = evaluateArm(arm, statTasks, GRAPH, style);
          if (!rep.applicable) continue;
          rows.push({
            N: n, seed, style, arm: rep.arm, metric: 'pass1', value: rep.passRate,
            ciLo: rep.ci95[0], ciHi: rep.ci95[1], n: rep.total,
          });
        }
        // trained 专属：冗余路径/路由/冲突率（诊断列，不进主指标门禁）
        if (style === 'follow') {
          const pe = pathExcess(selectedEpoch.policy, GRAPH, subset);
          rows.push({ N: n, seed, style, arm: 'trained', metric: 'path_excess', value: pe.mean, ciLo: null, ciHi: null, n: pe.successCount });
        } else {
          const solvedPlans = new Map<string, readonly string[]>();
          for (const t of subset) {
            const r = rollout(selectedEpoch.policy, GRAPH, t, true);
            if (r.accepted && r.trace.length >= 1) {
              solvedPlans.set(taskHash(t), r.trace.slice(0, -1).map((s) => s.action));
            }
          }
          const sos = stepsOverShortest(subset, GRAPH, solvedPlans);
          rows.push({ N: n, seed, style, arm: 'trained', metric: 'steps_over_shortest', value: sos.meanExcess, ciLo: null, ciHi: null, n: sos.total });
          rows.push({ N: n, seed, style, arm: 'trained', metric: 'steps_over_shortest_overbudget', value: sos.overBudget, ciLo: null, ciHi: null, n: sos.total });
          const car = safeActionConflictRate(statRecords.filter((r) => r.style === 'goal'), { tasks: subset, seed });
          rows.push({ N: n, seed, style, arm: 'trained', metric: 'safe_action_conflict_rate', value: car.rate, ciLo: null, ciHi: null, n: car.sampled });
        }
        const ra = routingAcc(selectedEpoch.policy, GRAPH, subset);
        rows.push({
          N: n, seed, style, arm: 'trained', metric: 'routing_acc',
          value: ra.total === 0 ? 0 : ra.match / ra.total, ciLo: null, ciHi: null, n: ra.total,
        });
      }
    }
  }

  // 幂律（trained pass@1，分 style；点不足如实 note，不外推）
  const powerLaw: Record<Style, PowerFit> = {
    follow: fitPowerLaw(rows.filter((r) => r.style === 'follow'), grid, seeds),
    goal: fitPowerLaw(rows.filter((r) => r.style === 'goal'), grid, seeds),
  };

  // 组合覆盖度 k% 副轴（两轴分列，禁止互顶替；产不出的组合如实计 skippedByK）
  let kCoverage: KcRow[] = [];
  let kCoverageSkipped: Record<number, number> = {};
  if (includeKCoverage) {
    const axis = runCoverageAxis({
      coverageKs,
      coverageN,
      styleRatio,
      runDir,
      trainer,
      valBin,
      saveLastK,
      extraArgs: opts.trainPyArgs,
      timeoutMs,
    });
    kCoverage = axis.rows;
    kCoverageSkipped = axis.skippedByK;
  }

  const meta: ResultMeta = {
    protocol: 'c8-v1',
    grid,
    seeds,
    world_version: worldVersion,
    style_ratio: styleRatio,
    val_per_family: valPerFamily,
    heldout_cap: heldoutCap,
    generated_at: new Date().toISOString(),
    trainer: 'controller/train.py',
  };
  const report: ScaleReport = {
    meta,
    rows,
    checkpoints,
    powerLaw,
    kCoverage,
    kCoverageSkipped,
    runDir,
    coverageSet: {
      taskCount: cov.tasks.length,
      unproducibleCount: cov.unproducibleCount,
      ineligibleCount: cov.ineligibleCount,
    },
  };
  // 落盘 + 原对象返回
  writeScaleResults(join(runDir, 'results.json'), join(runDir, 'results.csv'), report);
  return report;
}

// —— 公开面收敛：管道件与结果件经本文件透出（demos 只 import scale.js）——
export { fitPowerLaw, metaNumber, selectCheckpoint, writeScaleResults } from './scale_report.js';
export {
  PKG_ROOT,
  buildSplitBin,
  defaultTrainerPath,
  oracleRecords,
  runTrainer,
  sampleTasks,
  skeletonPool,
  stamp,
  type TrainerCall,
} from './scale_pipes.js';
export type {
  CheckpointRow,
  KcRow,
  PowerFit,
  ResultMeta,
  ScalePoint,
  ScaleReport,
  SelectedCheckpoint,
} from './scale_report.js';
export { runCoverageAxis, type CoverageAxisInput, type CoverageAxisResult } from './coverage_axis.js';
