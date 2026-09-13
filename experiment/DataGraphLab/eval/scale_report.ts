/**
 * scaling 结果的选点、幂律拟合与落盘（C.5/C.8 编排层；公开面经 eval/scale.ts 收敛）。
 *
 * checkpoint 选点口径：候选 = `train_meta.epoch_snapshots` 末 K 个 + 最终 `params`，
 * 与 `train.py` 的早停恢复逻辑对齐后在 val 上按 greedy pass@1（follow/goal 合并计数）
 * 比较；pass@1 一律 import metrics 的 `passAt1`（唯一口径），并列取更靠后的候选
 * （更晚 epoch 更接近收敛，C.8）。最终 params 与某快照逐值相同时不重复评估——
 * `train.py` 的 best 恢复本就来自某个 epoch，评估结果必然同值。
 *
 * 幂律拟合 `S(N)=S·(1−(N0/N)^α)` 用离散网格搜索最小残差平方（零依赖纪律：
 * 无 scipy/梯度下降），跨 seed 给出均值 ±1.96·se 的 95% CI；点不足时如实记
 * note，不外推、不编数。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Policy } from '../controller/policy.js';
import type { WeightsFile } from '../controller/checkpoint.js';
import { GRAPH } from '../runner/graph.js';
import { canonicalJson } from '../world/hash.js';
import { passAt1 } from './metrics.js';
import type { Style, Task } from '../schema.js';

/** 长表一行（results.csv 的 `N,seed,style,arm,metric,value,ci_lo,ci_hi,n`，逐列对应）。 */
export interface ScalePoint {
  readonly N: number;
  readonly seed: number;
  readonly style: 'follow' | 'goal';
  readonly arm: string;
  readonly metric: string;
  readonly value: number;
  readonly ciLo: number | null;
  readonly ciHi: number | null;
  readonly n: number;
}

/** 每个 (N,seed) 的选点记录：epoch 为快照序号（final params 命中时取 best_epoch）。 */
export interface CheckpointRow {
  readonly N: number;
  readonly seed: number;
  readonly selected_snapshot_epoch: number | null;
  readonly final_val_ce: number | null;
  readonly best_val_pass1: number;
}

/** 覆盖度轴一行：k% 训练骨架覆盖下的 trained pass@1（C.8 副轴）。 */
export interface KcRow {
  readonly k: number;
  readonly style: 'follow' | 'goal';
  readonly pass1: number;
  readonly n: number;
}

export interface PowerFit {
  readonly S_inf: number | null;
  readonly alpha: number | null;
  readonly ci95_S_inf: readonly [number, number] | null;
  readonly ci95_alpha: readonly [number, number] | null;
  readonly fitted_on: readonly number[];
  readonly note: string;
}

export interface ResultMeta {
  readonly protocol: 'c8-v1';
  readonly grid: readonly number[];
  readonly seeds: readonly number[];
  readonly world_version: string;
  readonly style_ratio: number;
  readonly val_per_family: number;
  readonly heldout_cap: number;
  readonly generated_at: string;
  readonly trainer: string;
}

/** runScale 的内存返回体：results.json 五段 + 落盘目录与覆盖集清单。 */
export interface ScaleReport {
  readonly meta: ResultMeta;
  readonly rows: ScalePoint[];
  readonly checkpoints: CheckpointRow[];
  readonly powerLaw: Readonly<Record<Style, PowerFit>>;
  readonly kCoverage: KcRow[];
  readonly runDir: string;
  readonly coverageSet: {
    readonly taskCount: number;
    readonly unproducibleCount: number;
    readonly ineligibleCount: number;
  };
  /** 副轴各 k 产不出而被跳过的（骨架×style×family）组合数；不进 results.json（内存透明件）。 */
  readonly kCoverageSkipped?: Readonly<Record<number, number>>;
}

export interface SelectedCheckpoint {
  readonly policy: Policy;
  readonly selectedSnapshotEpoch: number | null;
  readonly bestValPass1: number;
}

/** 数值型 train_meta 字段的安全读出（桩/旧档缺字段时如实 null，不猜值）。 */
export function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface Snapshot {
  readonly epoch: number;
  readonly params: WeightsFile['params'];
}

function snapshotsOf(file: WeightsFile, lastK: number): Snapshot[] {
  const raw = file.train_meta.epoch_snapshots;
  if (!Array.isArray(raw)) return [];
  const snaps: Snapshot[] = [];
  for (const item of raw) {
    if (item !== null && typeof item === 'object' && 'epoch' in item && 'params' in item) {
      const s = item as { epoch: unknown; params: WeightsFile['params'] };
      if (typeof s.epoch === 'number') snaps.push({ epoch: s.epoch, params: s.params });
    }
  }
  snaps.sort((a, b) => a.epoch - b.epoch);
  return snaps.slice(-Math.max(1, lastK));
}

/**
 * 贪心选点：按快照 epoch 升序、最终 params 收尾构成候选链，合并两 style 的
 * greedy pass@1 比较；并列取更靠后者。返回选中候选直接构造好的 Policy，
 * 避免下游再解析一次权重（同一 params 对象）。
 */
export function selectCheckpoint(
  file: WeightsFile,
  valTasks: readonly Task[],
  lastK: number,
): SelectedCheckpoint {
  const seen = new Set<string>();
  const candidates: Array<{ epoch: number | null; params: WeightsFile['params'] }> = [];
  const snaps = snapshotsOf(file, lastK);
  const metaBestEpoch = metaNumber(file.train_meta, 'best_epoch');
  for (const s of snaps) {
    const key = canonicalJson(s.params);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ epoch: s.epoch, params: s.params });
  }
  if (!seen.has(canonicalJson(file.params))) {
    candidates.push({ epoch: metaBestEpoch ?? (snaps.length > 0 ? snaps[snaps.length - 1]!.epoch + 1 : 0), params: file.params });
  }
  const followVal = valTasks.filter((t) => t.style === 'follow');
  const goalVal = valTasks.filter((t) => t.style === 'goal');
  let best: SelectedCheckpoint | null = null;
  for (const cand of candidates) {
    const policy = new Policy(cand.params, file.dims.featureSet, file.dims.head);
    const f = passAt1(policy, GRAPH, followVal);
    const g = passAt1(policy, GRAPH, goalVal);
    const total = f.total + g.total;
    const rate = total === 0 ? 0 : (f.solved + g.solved) / total;
    if (best === null || rate >= best.bestValPass1) {
      best = { policy, selectedSnapshotEpoch: cand.epoch, bestValPass1: rate };
    }
  }
  if (best === null) {
    return { policy: new Policy(file.params, file.dims.featureSet, file.dims.head), selectedSnapshotEpoch: null, bestValPass1: 0 };
  }
  return best;
}

// —— 幂律拟合 ————————————————————————————————————————————————

const N0_GRID = [1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 300, 500, 800, 1000];
const ALPHA_GRID = Array.from({ length: 20 }, (_, i) => 0.05 * (i + 1));
const SINF_GRID = Array.from({ length: 12 }, (_, i) => Number((0.5 + 0.05 * i).toFixed(2)));

interface Point { readonly N: number; readonly s: number }

function sseOf(p: Point[], n0: number, alpha: number, sInf: number): number {
  let acc = 0;
  for (const { N, s } of p) {
    const pred = sInf * (1 - Math.pow(n0 / N, alpha));
    acc += (s - pred) * (s - pred);
  }
  return acc;
}

/** 单 seed 曲线拟合；点数 <3 时残差自由度不足，返回 null 由上层记 note。 */
function fitOne(p: Point[]): { S_inf: number; alpha: number } | null {
  if (p.length < 3) return null;
  let best = Infinity;
  let arg: { S_inf: number; alpha: number } | null = null;
  for (const n0 of N0_GRID) {
    for (const alpha of ALPHA_GRID) {
      for (const sInf of SINF_GRID) {
        const ss = sseOf(p, n0, alpha, sInf);
        if (ss < best) {
          best = ss;
          arg = { S_inf: sInf, alpha };
        }
      }
    }
  }
  return arg;
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function se(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v) / Math.sqrt(xs.length);
}

/** trained pass@1 → 每 seed 拟合 → 均值 ±1.96·se 的 (α, S∞) 区间（C.8/D 表）。 */
export function fitPowerLaw(rows: readonly ScalePoint[], grid: readonly number[], seeds: readonly number[]): PowerFit {
  const empty = (note: string): PowerFit => ({
    S_inf: null, alpha: null, ci95_S_inf: null, ci95_alpha: null, fitted_on: grid, note,
  });
  const fits: Array<{ S_inf: number; alpha: number }> = [];
  let anyPoint = false;
  for (const seed of seeds) {
    const pts = grid
      .map((n) => ({ n, v: trainedAt(rows, n, seed) }))
      .filter((e) => e.v !== null)
      .map((e) => ({ N: e.n, s: e.v as number }));
    if (pts.length > 0) anyPoint = true;
    const f = fitOne(pts);
    if (f !== null) fits.push(f);
  }
  if (!anyPoint) return empty('无 trained pass@1 数据点，拟合未执行');
  if (fits.length === 0) return empty('有效拟合点数 <3（N 网格太稀），拟合未执行');
  const sInfs = fits.map((f) => f.S_inf);
  const alphas = fits.map((f) => f.alpha);
  const ci = (xs: readonly number[]): [number, number] => {
    const m = mean(xs);
    const e = 1.96 * se(xs);
    return [m - e, m + e];
  };
  return {
    S_inf: mean(sInfs),
    alpha: mean(alphas),
    ci95_S_inf: ci(sInfs),
    ci95_alpha: ci(alphas),
    fitted_on: grid,
    note: fits.length < seeds.length ? `仅 ${String(fits.length)}/${String(seeds.length)} 个 seed 可拟合` : '',
  };
}

function trainedAt(rows: readonly ScalePoint[], n: number, seed: number): number | null {
  const hit = rows.filter((r) => r.N === n && r.seed === seed && r.arm === 'trained' && r.metric === 'pass1');
  if (hit.length === 0) return null;
  return mean(hit.map((r) => r.value));
}

// —— results.{json,csv} 落盘（钉死的 G1.x 读取契约）——————————————————————

function rowToJson(r: ScalePoint): Record<string, unknown> {
  return {
    N: r.N, seed: r.seed, style: r.style, arm: r.arm, metric: r.metric,
    value: r.value, ci_lo: r.ciLo, ci_hi: r.ciHi, n: r.n,
  };
}

function fitToJson(f: PowerFit): Record<string, unknown> {
  return {
    S_inf: f.S_inf, alpha: f.alpha, ci95_S_inf: f.ci95_S_inf, ci95_alpha: f.ci95_alpha,
    fitted_on: f.fitted_on, note: f.note,
  };
}

/** 同一 report 双格式落盘：json 原样五段；csv 长表（表头 + 每 row 一行，null 落空串）。 */
export function writeScaleResults(jsonPath: string, csvPath: string, report: ScaleReport): void {
  const doc = {
    meta: report.meta,
    rows: report.rows.map(rowToJson),
    checkpoints: report.checkpoints,
    power_law: { follow: fitToJson(report.powerLaw.follow), goal: fitToJson(report.powerLaw.goal) },
    k_coverage: report.kCoverage,
  };
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const lines = ['N,seed,style,arm,metric,value,ci_lo,ci_hi,n'];
  for (const r of report.rows) {
    lines.push([r.N, r.seed, r.style, r.arm, r.metric, r.value, r.ciLo ?? '', r.ciHi ?? '', r.n].join(','));
  }
  writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8');
}
