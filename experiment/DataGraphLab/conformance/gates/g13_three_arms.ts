/**
 * G1.3 三臂齐全（A.2 / docs/gates.md G1.3）：与 G1.2 消费同一份 C.8 scaling 产物
 * `results.json`（读取唯一口径 results_view.ts）。齐全性判据按 style 分开钉死：
 * follow 行必须出现 arm ∈ {heuristic, random, trained}，goal 行必须出现
 * arm ∈ {random, planner, trained}；`contract_route` 为可选对照列（缺席不红）。
 * 任一必含臂缺失即 FAIL，notes 逐 style 列缺臂并带出已报臂清单（机器可读面取
 * 计数：GateResult.metrics 的数值约束决定清单全文在 notes，禁把数组塞 metrics）。
 * results 文件缺失同样 FAIL 并提示先跑 C.8 scale——「没跑」不是「齐全」。
 */

import { existsSync, readFileSync } from 'node:fs';

import { buildResult, memoized, type GateContext, type GateResult } from './common.js';
import { armsByStyle, loadResultsFile, type ResultsFile } from './results_view.js';

const VERSION = 1;
/** A.2 表：每份报告含 heuristic(follow)/random/trained；goal 另含 planner 上界。 */
const FOLLOW_REQUIRED: readonly string[] = ['heuristic', 'random', 'trained'];
const GOAL_REQUIRED: readonly string[] = ['random', 'planner', 'trained'];
/** 可选对照列（§8 廉价机制臂），只入证据不进门禁。 */
const OPTIONAL_ARMS: readonly string[] = ['contract_route'];

function missing(required: readonly string[], present: readonly string[]): string[] {
  return required.filter((a) => !present.includes(a));
}

function notFound(ctx: GateContext, note: string): GateResult {
  return buildResult({
    gate: 'G1.3',
    version: VERSION,
    ctx,
    seeds: [],
    metrics: { follow_required_present: 0, goal_required_present: 0, follow_arms_reported: 0, goal_arms_reported: 0, complete: 0 },
    thresholds: { 'complete:eq': 1 },
    notes: note,
  });
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
    return notFound(ctx, `${err instanceof Error ? err.message : String(err)}——证据文件破坏按缺失处理，先修 scale 再复跑（G1.2 同口径兜底）`);
  }
  const followArms = armsByStyle(file, 'follow');
  const goalArms = armsByStyle(file, 'goal');
  const followMissing = missing(FOLLOW_REQUIRED, followArms);
  const goalMissing = missing(GOAL_REQUIRED, goalArms);
  const complete = followMissing.length === 0 && goalMissing.length === 0;
  const seeds = [...new Set(file.rows.map((r) => r.seed))].sort((a, b) => a - b);
  return buildResult({
    gate: 'G1.3',
    version: VERSION,
    ctx,
    seeds,
    metrics: {
      follow_required_present: FOLLOW_REQUIRED.length - followMissing.length,
      goal_required_present: GOAL_REQUIRED.length - goalMissing.length,
      follow_arms_reported: followArms.length,
      goal_arms_reported: goalArms.length,
      complete: complete ? 1 : 0,
    },
    thresholds: {
      'complete:eq': 1,
    },
    notes: complete
      ? `三臂齐全（可选列另报）：follow_arms=[${followArms.join(', ')}]、goal_arms=[${goalArms.join(', ')}]，必含 ⊆ 见 A.2（证据 ${path}；可选对照臂 ${OPTIONAL_ARMS.join('/')} 缺席不红）`
      : `缺臂：follow=[${followMissing.join(', ')}]、goal=[${goalMissing.join(', ')}]（已报 follow=[${followArms.join(', ')}]、goal=[${goalArms.join(', ')}]，证据 ${path}）——每份报告三臂对照缺一不可（A.2），补 scale 网格后复跑`,
  });
}

/** 公开入口：同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G1.3', ctx, () => compute(ctx));
}
