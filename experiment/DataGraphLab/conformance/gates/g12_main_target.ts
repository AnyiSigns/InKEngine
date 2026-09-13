/**
 * G1.2 主目标（A.1 / docs/gates.md G1.2）：消费 C.8 scaling 产物
 * `ctx.results.json`（results.json 长表，读取与聚合唯一口径见 results_view.ts）。
 * 判定式照 A.1 原样写死：`S_goal(10_000) ≥ 0.50`、`S_follow(10_000) ≥ 0.80`、
 * `S_follow(10k) − S_heur_follow(10k) ≥ 0.05`（heuristic 行必须存在）；单调性
 * `S_goal(30_000) ≥ S_goal(1_000)`——网格缺 30000 点时该项**跳过**并在 notes 标
 * `monotonicity: skipped(no 30k)`，不拿缺证当通过也不当失败。主指标一律取
 * `trained` 臂 `pass1` 行的跨 seed 均值（C.8 均值口径）。results 文件缺失/网格缺
 * 10000 点都 FAIL 并带显式 notes（先跑 scale / 补网格），**不许改阈值、不许删
 * 基线**（A.1/E.7），不达标报告须附三分诊断。
 */

import { existsSync, readFileSync } from 'node:fs';

import { buildResult, memoized, type GateContext, type GateResult } from './common.js';
import { loadResultsFile, meanBy, seedsBy, type ResultsFile, type RowSlice } from './results_view.js';

const VERSION = 1;
const N_1K = 1_000;
const N_10K = 10_000;
const N_30K = 30_000;
const S_GOAL_MIN = 0.5;
const S_FOLLOW_MIN = 0.8;
const HEUR_MARGIN_MIN = 0.05;
/** 缺数据/缺行的占位值：取 -1 保证 min 阈值必红，notes 负责归因（不 NaN 进 JSON）。 */
const ABSENT = -1;

const slice = (N: number, style: string, arm: string): RowSlice => ({ N, style, arm, metric: 'pass1' });

function fmt(v: number): string {
  return v.toFixed(4);
}

/** 说明性 notes 里的防御性格式化：pass 分支数值必存在，占位仅绝路兜底。 */
function fmt2(v: number | undefined): string {
  return fmt(v ?? ABSENT);
}

function notFound(ctx: GateContext, note: string): GateResult {
  return buildResult({
    gate: 'G1.2',
    version: VERSION,
    ctx,
    seeds: [],
    metrics: {
      S_goal_10k: ABSENT,
      S_follow_10k: ABSENT,
      S_heur_follow_10k: ABSENT,
      follow_minus_heur: ABSENT,
      monotonicity_ok: ABSENT,
      monotonicity_checked: 0,
      grid_has_10k: 0,
      grid_has_30k: 0,
    },
    thresholds: commonThresholds(),
    notes: note,
  });
}

function commonThresholds(): Record<string, number> {
  return {
    'grid_has_10k:eq': 1,
    'S_goal_10k:min': S_GOAL_MIN,
    'S_follow_10k:min': S_FOLLOW_MIN,
    'follow_minus_heur:min': HEUR_MARGIN_MIN,
    'monotonicity_ok:min': 1,
  };
}

function compute(ctx: GateContext): GateResult {
  const path = ctx.resultsPath;
  if (path === undefined) {
    return notFound(ctx, 'results.json not found: run C.8 scale first（ctx.resultsPath 未注入且 runs/ 下无含 results.json 的 scale 目录）');
  }
  if (!existsSync(path)) {
    return notFound(ctx, `results.json not found: run C.8 scale first（${path}）`);
  }
  let file: ResultsFile;
  try {
    file = loadResultsFile(path, (p) => readFileSync(p, 'utf8'));
  } catch (err) {
    return notFound(ctx, `${err instanceof Error ? err.message : String(err)}——证据文件破坏按缺失处理，先修 scale 再复跑`);
  }
  const goal10k = meanBy(file, slice(N_10K, 'goal', 'trained'));
  const follow10k = meanBy(file, slice(N_10K, 'follow', 'trained'));
  const heur10k = meanBy(file, slice(N_10K, 'follow', 'heuristic'));
  const gridHas10k = goal10k !== undefined && follow10k !== undefined;
  const goal1k = meanBy(file, slice(N_1K, 'goal', 'trained'));
  const goal30k = meanBy(file, slice(N_30K, 'goal', 'trained'));
  const gridHas30k = goal30k !== undefined ? 1 : 0;
  // 单调性判定式 = S_goal(30k) ≥ S_goal(1k)；任一端点缺行都只能跳过（缺证不判）。
  const monoCheckable = goal1k !== undefined && goal30k !== undefined;
  const monotonicityOk = !monoCheckable
    ? 1
    : goal30k >= goal1k
      ? 1
      : 0;
  const sv = (v: number | undefined): number => v ?? ABSENT;
  const metrics: Record<string, number> = {
    S_goal_10k: sv(goal10k),
    S_follow_10k: sv(follow10k),
    S_heur_follow_10k: sv(heur10k),
    follow_minus_heur: diffOrAbsent(follow10k, heur10k),
    monotonicity_ok: monotonicityOk,
    monotonicity_checked: monoCheckable ? 1 : 0,
    grid_has_10k: gridHas10k ? 1 : 0,
    grid_has_30k: gridHas30k,
  };
  const seeds = [...new Set([...seedsBy(file, slice(N_10K, 'goal', 'trained')), ...seedsBy(file, slice(N_10K, 'follow', 'trained'))])].sort((a, b) => a - b);
  const problems: string[] = [];
  if (!gridHas10k) {
    problems.push('grid missing N=10000');
  }
  if (gridHas10k && heur10k === undefined) {
    problems.push('heuristic 行缺失（S_heur 对照不许删基线，A.1：S_follow−S_heur ≥ 0.05 必须可算）');
  }
  // 主判据违反也要点名，notes 归因与 evaluateThresholds 结论保持一致（判据仍只由
  // metrics×thresholds 机器复算，这里只负责失败模式说明，不做第二套判定）。
  if (goal10k !== undefined && goal10k < S_GOAL_MIN) {
    problems.push(`S_goal(10k)=${fmt(goal10k)} <${String(S_GOAL_MIN)}（目标式主指标不达标）`);
  }
  if (follow10k !== undefined && follow10k < S_FOLLOW_MIN) {
    problems.push(`S_follow(10k)=${fmt(follow10k)} <${String(S_FOLLOW_MIN)}`);
  }
  if (follow10k !== undefined && heur10k !== undefined && follow10k - heur10k < HEUR_MARGIN_MIN) {
    problems.push(`S_follow−S_heur=${fmt(follow10k - heur10k)} <${String(HEUR_MARGIN_MIN)}（消歧+组合增益不足：heur=${fmt(heur10k)}）`);
  }
  let notes = '';
  if (goal1k !== undefined && goal30k !== undefined && monotonicityOk === 0) {
    problems.push(`单调性破坏：S_goal(30k)=${fmt(goal30k)} < S_goal(1k)=${fmt(goal1k)}`);
  }
  if (problems.length === 0) {
    const mono = goal1k !== undefined && goal30k !== undefined
      ? `单调性 S_goal(30k)=${fmt(goal30k)} ≥ S_goal(1k)=${fmt(goal1k)}`
      : 'monotonicity: skipped(no 30k)';
    notes =
      `A.1 达成：S_goal(10k)=${fmt2(goal10k)} ≥${String(S_GOAL_MIN)}、S_follow(10k)=${fmt2(follow10k)} ≥${String(S_FOLLOW_MIN)}、` +
      `S_follow−S_heur=${fmt((follow10k ?? 0) - (heur10k ?? 0))} ≥${String(HEUR_MARGIN_MIN)}（heur=${fmt2(heur10k)}）；${mono}` +
      `（证据 ${path}，trained 臂 pass1 跨 seed 均值，seed∈{${seeds.join(',')}}）`;
  } else {
    notes =
      `失败模式：${problems.join('；')}——不许改阈值/删基线（A.1/E.7），不达标须附` +
      `「表示容量 / 数据覆盖 / 目标可达性」三分诊断（证据 ${path}）`;
  }
  return buildResult({
    gate: 'G1.2',
    version: VERSION,
    ctx,
    seeds,
    metrics,
    thresholds: commonThresholds(),
    notes,
  });
}

/** 差值只在两端都可算时产出，否则 -1 占位（notes 负责说明缺哪端）。 */
function diffOrAbsent(follow: number | undefined, heur: number | undefined): number {
  return follow === undefined || heur === undefined ? ABSENT : follow - heur;
}

/** 公开入口：同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G1.2', ctx, () => compute(ctx));
}
