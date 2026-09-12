/**
 * heldout 可产域判定（C.1 覆盖集前置；从 gen/generator.ts 拆出以满足单文件
 * ≤350 行纪律，gen/generator.ts 再 import/re-export 本文件公开符号）。
 *
 * 部分骨架在 goal 族结构性不可产：str_len 收尾的 Str 骨架终值是 Int，而 Str
 * 目标词表只收 len；纯长度保持骨架永远无法「初始不达标且终值达标」。覆盖构造
 * 遇到它们不会报错，只会把 80×200 预算×50 重试全部空烧。`UNPRODUCIBLE_HELDOUT`
 * 在模块加载时一次性精确判定该域（键 = `style:family:composition_id`，稳定串
 * 拼接，manifest/报告可直接消费），makeCoverageSplit 据此跳过并计数。
 *
 * 判据 = 存在（目标池实例 × witness）满足「初始不达标 ∧ 终值达标 ∧ 无单步捷径」。
 * Int 判定精确：PROBE_INT（−50..50）即 sampleValue 全域，目标池为 sampleGoal 的
 * Int 全部 30 个合式实例，逐点回放可穷举。Str 判定保守：witness 只搜「长度
 * 1..8 各一代表串」的有界集 × len 目标池——len 只读终值长度，长度是最充分的
 * 统计量，故漏产概率极低，但判「不可产」仍按保守口径记录。follow 族按构造全域
 * 可产（任意 witness 回放类型合法计划都穿验收），同样逐骨架做一次验证，判出
 * 不达标者照样入册，由覆盖构造的守卫抛错兜底。
 */

import { PROBE_INT, SKELETONS, _skelId, type Skel } from './skeletons.js';
import { HELDOUT_SKELETONS } from './splits.js';
import { accept } from '../verify/acceptor.js';
import { GRAPH, candidates } from '../runner/graph.js';
import { applyOp, EXIT, initState, runPlan, type Graph } from '../world/operators.js';
import { goalOk, type Goal } from '../world/goal.js';
import type { Family, Root, Style, Task } from '../schema.js';

/** 注册表键：`${style}:${family}:${composition_id}`（覆盖/报告共用口径）。 */
export function coverageKey(style: Style, family: Family, compositionId: string): string {
  return `${style}:${family}:${compositionId}`;
}

/**
 * C.1 `has_one_step_solution`：depth-1 捷径守卫——任一单步（含 echo/submit）
 * 直接过验收即拒采。只需 O(|candidates|) 次 apply+accept，不必整图 BFS，
 * 也避免 gen → teacher 反向依赖。
 */
export function hasOneStepSolution(task: Task, graph: Graph): boolean {
  const st = initState(task.x, task.spec);
  for (const a of candidates(graph, st, st.hist)) {
    if (a === EXIT) continue;
    const st2 = applyOp(graph, a, st);
    if (st2 !== null && accept(task, st2)) return true;
  }
  return false;
}

/** INT_GOALS 可采出的单体目标全集（parity 奇偶 × gt 三端点）。 */
const INT_SINGLE_GOALS: readonly Goal[] = [
  { kind: 'parity', target: 0 },
  { kind: 'parity', target: 1 },
  { kind: 'gt', target: 0 },
  { kind: 'gt', target: 5 },
  { kind: 'gt', target: 20 },
];

/** sampleGoal 的 Int 目标全谱：5 单体 + 5×5 有序合取 = 30（parity 合取自身矛盾自动淘汰）。 */
export const INT_GOAL_POOL: readonly Goal[] = (() => {
  const out: Goal[] = [...INT_SINGLE_GOALS];
  for (const a of INT_SINGLE_GOALS) {
    for (const b of INT_SINGLE_GOALS) out.push({ kind: 'all', of: [a, b] });
  }
  return out;
})();

/** sampleGoal 的 Str 目标全谱：len 端点 min∈{1,2} × max∈{3,4,5}；池只一项，永不合取。 */
export const STR_GOAL_POOL: readonly Goal[] = (() => {
  const out: Goal[] = [];
  for (const min of [1, 2]) for (const max of [3, 4, 5]) out.push({ kind: 'len', min, max });
  return out;
})();

/** Str 有界 witness 集：长度 1..8 各一代表串（len 目标只读终值长度，长度即充分统计量）。 */
const STR_WITNESSES: readonly string[] = Array.from({ length: 8 }, (_, i) => 'a'.repeat(i + 1));

/** 判据用合成 goal 族任务：验收只消费 x/spec/family/expected，其余字段占位。 */
function synthGoalTask(
  root: Root,
  skeleton: readonly string[],
  family: Family,
  goal: Goal,
  x: number | string,
  expected: number | string,
): Task {
  return {
    style: 'goal',
    family,
    instruction: '',
    x,
    spec: { goal },
    expected,
    plan_hidden: [...skeleton, 'submit'],
    root,
    plan_hash: '',
    composition_id: '',
    split: 'heldout',
  };
}

/** goal 域判定（goal 与 goal_verify 同判据）：goal_verify 的双通道由 check_* 从终值派生，恒可通过。 */
function goalDomainProducible(sk: Skel): boolean {
  const witnesses: readonly (number | string)[] = sk.root === 'Int' ? PROBE_INT : STR_WITNESSES;
  const pool = sk.root === 'Int' ? INT_GOAL_POOL : STR_GOAL_POOL;
  // 终值只回放一遍（witness 集 ≪ 目标池 × witness 的笛卡儿积），逐目标位比对即可。
  const finals: (number | string | null)[] = witnesses.map((x) => {
    const st = runPlan(sk.plan, initState(x));
    return st === null ? null : (st.x as number | string);
  });
  for (const goal of pool) {
    for (let i = 0; i < witnesses.length; i++) {
      const expected = finals[i];
      if (expected === null || expected === undefined) continue;
      const x = witnesses[i]!;
      if (goalOk(x, { goal }) || !goalOk(expected, { goal })) continue;
      if (hasOneStepSolution(synthGoalTask(sk.root, sk.plan, 'goal', goal, x, expected), GRAPH)) continue;
      return true;
    }
  }
  return false;
}

/** follow 域判定：固定 witness（Int 7 / Str 'abcd'）一次回放即构造性证明存在可产任务。 */
function followDomainProducible(sk: Skel): boolean {
  const x: number | string = sk.root === 'Int' ? 7 : 'abcd';
  const plan = [...sk.plan, 'submit'];
  const st = runPlan(plan, initState(x));
  if (st === null) return false;
  const task: Task = {
    style: 'follow',
    family: 'value',
    instruction: '',
    x,
    spec: {},
    expected: st.x as number | string,
    plan_hidden: plan,
    root: sk.root,
    plan_hash: '',
    composition_id: '',
    split: 'heldout',
  };
  return accept(task, st);
}

/**
 * heldout 已知不可产注册表（模块加载时一次性确定性计算）。
 * goal 两族共享判定；follow 两族按构造全域可产——若判出不可产照样入册，
 * 由 makeCoverageSplitInfo 的 follow 守卫抛错兜底。
 */
export const UNPRODUCIBLE_HELDOUT: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  for (const sk of SKELETONS) {
    const id = _skelId(sk);
    if (!HELDOUT_SKELETONS.has(id)) continue;
    if (!followDomainProducible(sk)) {
      keys.add(coverageKey('follow', 'value', id));
      keys.add(coverageKey('follow', 'verify', id));
    }
    if (!goalDomainProducible(sk)) {
      keys.add(coverageKey('goal', 'goal', id));
      keys.add(coverageKey('goal', 'goal_verify', id));
    }
  }
  return keys;
})();
