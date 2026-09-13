/**
 * G1.1 非免费午餐（A.2 / docs/gates.md G1.1）：C.8 统计集口径的 heldout 批次
 * （`makeSplit('heldout', perFamily=min(max(30,|HELDOUT_SKELETONS|),300), seed=0)`，
 * 经 ctx.genTasks 同口径缓存）上，`RandomArm(seed=123)` 两 style 各自 greedy
 * pass@1（每题一次，走 evaluateArm/passAt1 唯一口径）。两 style 同时 ≤0.05 才
 * PASS——未训练的随机权重不许白拿端到端成功；任一越线按 E.7 如实报告失败模式，
 * **不许改阈值**。随机性只在 arm 的 Policy.random(seed)（世界无 Math.random）。
 */

import { HELDOUT_SKELETONS } from '../../gen/generator.js';
import { GRAPH } from '../../runner/graph.js';
import { RandomArm, evaluateArm } from '../../eval/arms.js';
import { buildResult, memoized, type BatchSpec, type GateContext, type GateResult } from './common.js';

const VERSION = 1;
/** 批次 seed（统计集，C.8）与 random 臂 seed 钉死；阈值 0.05 原样写死。 */
const BATCH_SEED = 0;
const ARM_SEED = 123;
const PASS1_MAX = 0.05;
/** C.8 HELDOUT_CAP：上限防骨架膨胀后 held-out 反超训练 N。 */
const HELDOUT_CAP = 300;

function heldoutPerFamily(): number {
  return Math.min(Math.max(30, HELDOUT_SKELETONS.size), HELDOUT_CAP);
}

function pct(p: number): string {
  return p.toFixed(4);
}

function compute(ctx: GateContext): GateResult {
  const spec: BatchSpec = { split: 'heldout', perFamily: heldoutPerFamily(), seed: BATCH_SEED };
  const tasks = ctx.genTasks(spec);
  const arm = new RandomArm(ARM_SEED);
  const follow = evaluateArm(arm, tasks, GRAPH, 'follow');
  const goal = evaluateArm(arm, tasks, GRAPH, 'goal');
  const metrics: Record<string, number> = {
    pass1_follow: follow.passRate,
    pass1_goal: goal.passRate,
    n_follow: follow.total,
    n_goal: goal.total,
    seed: ARM_SEED,
  };
  const ok = follow.passRate <= PASS1_MAX && goal.passRate <= PASS1_MAX;
  return buildResult({
    gate: 'G1.1',
    version: VERSION,
    ctx,
    seeds: [BATCH_SEED, ARM_SEED],
    metrics,
    thresholds: {
      'pass1_follow:max': PASS1_MAX,
      'pass1_goal:max': PASS1_MAX,
      'n_follow:min': 1,
      'n_goal:min': 1,
    },
    notes: ok
      ? `random 臂 pass@1：follow=${pct(follow.passRate)}（n=${String(follow.total)}，CI [${follow.ci95.map(pct).join(', ')}]）、goal=${pct(goal.passRate)}（n=${String(goal.total)}，CI [${goal.ci95.map(pct).join(', ')}]），两 style 同时 ≤${String(PASS1_MAX)}（统计集 perFamily=${String(spec.perFamily)}、批次 seed=${String(BATCH_SEED)}、臂 seed=${String(ARM_SEED)}）`
      : `失败模式：random 臂 pass@1 越线（follow=${pct(follow.passRate)} goal=${pct(goal.passRate)}，阈 ≤${String(PASS1_MAX)}）——世界存在可白拿的免费午餐（捷径/泄漏/目标过易），按 E.7 如实报告，不许改阈值；先查 G0.4 泄漏与 C.1 极小性守卫`,
  });
}

/** 公开入口：同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G1.1', ctx, () => compute(ctx));
}
