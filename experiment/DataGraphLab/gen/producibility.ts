/**
 * 生成侧判定层（C.1 判定段；从 gen/generator.ts 拆出以满足单文件 ≤350 行纪律，
 * gen/generator.ts import 本文件并维持 appendix D 的公开端口）。
 *
 * 三件判定共用同一份语义源：
 * ① `goalEligible(root, skeleton)`——族适格性：该骨架能否**改变**达标性，即存在
 *    （可采目标 × 采样域 witness）满足「初始不达标 ∧ 终值达标」。Int 用 PROBE_INT
 *    全域 ⇒ 判定精确；Str 用 PROBE_STR——len 目标只依赖终值长度，世界无缩短字符串
 *    的算子，PROBE_STR 覆盖长度 1..5 即覆盖全部可达组合（>5 的 witness 达标后终值
 *    只会更长），故 Str 侧同样是决定性的。长度不变类骨架（upper/lower/reverse 组合、
 *    str_len 收尾的 Int 终值）对任何目标都产不出 goal 任务 → 判不适格，从 goal 族
 *    覆盖声明与配额池剔除，并由 makeCoverageSplit 显式计数上报（R2-P0-2，不静默）。
 * ② `hasOneStepSolution`（goal 族自带守卫，depth-1 捷径）与 `hasShortcut`（follow 族
 *    极小性守卫，R2-P0-3：单算子+收尾提交过验收且**严格短于**金计划 → 非最小）。
 *    「严格短于」是必要限定：深度 1 骨架自己的算子+提交恰为金计划本身，判捷径会把
 *    整个深度 1 follow 域清空；真捷径例子是 [mod7] 开头 × x∈0..6（起点直接 submit 即
 *    达标）这类「存在更短合法计划」的情形。
 * ③ `UNPRODUCIBLE_HELDOUT`——heldout 报告注册表，goal 两族的键**由 goalEligible 派生**
 *    （薄层，不再是第二套判定）：goal 族 witness 已要求初始不达标，submit/echo 单步
 *    必然失手 ⇒ hasShortcut 在适格对上是死项 ⇒ 「适格」与「可产」同域，注册表退化为
 *    适格性的 heldout 视图；follow 两族按构造全域可产，判出即入册，由覆盖构造守卫
 *    抛错兜底（键 = `style:family:composition_id`，manifest/报告可直接消费）。
 */

import { PROBE_INT, PROBE_STR, SKELETONS, _skelId, type Skel } from './skeletons.js';
import { HELDOUT_SKELETONS } from './splits.js';
import { accept } from '../verify/acceptor.js';
import { GRAPH, candidates } from '../runner/graph.js';
import {
  applyOp,
  emod,
  EXIT,
  initState,
  runPlan,
  type Graph,
  type State,
} from '../world/operators.js';
import { t } from '../world/types.js';
import { goalOk, type Goal } from '../world/goal.js';
import type { Family, Root, Style, Task } from '../schema.js';

/** 注册表键：`${style}:${family}:${composition_id}`（覆盖/报告共用口径）。 */
export function coverageKey(style: Style, family: Family, compositionId: string): string {
  return `${style}:${family}:${compositionId}`;
}

/** 终算子收尾唯一入口（C.1）：verify/goal_verify 依终值类型选 check_* 并写入 spec。 */
export function _commit(
  family: Family,
  skeleton: readonly string[],
  expected: number | string,
): { plan: string[]; spec: Record<string, unknown> } | null {
  const plan = [...skeleton, 'submit'];
  let spec: Record<string, unknown> = {};
  if (family === 'verify' || family === 'goal_verify') {
    if (t(expected) === 'Int') {
      spec = { parity: emod(expected as number, 2) };
      plan.push('check_parity');
    } else if (t(expected) === 'Str') {
      spec = { length: (expected as string).length };
      plan.push('check_len');
    } else {
      return null;
    }
  }
  return { plan, spec };
}

/** goal 域族判定（R2-P0-2）：goal 与 goal_verify 同池采样目标，适格性对两族一致。 */
export function isGoalDomain(family: Family): boolean {
  return family === 'goal' || family === 'goal_verify';
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

/**
 * C.1 `has_shortcut`（R2-P0-3）：follow 族极小性守卫——存在「任一单步算子 +
 * 收尾提交」过验收，且该捷径计划**严格短于**金计划 ⇒ 任务非最小，换 witness。
 * 收尾提交按族补 `submit(+check_*)`：verify 家族的 verdict 由 _commit 从终值现场
 * 派生，与验收指纹一致 ⇒ 捷径判定与 check_* 的 pass:hash8 语义天然兼容。
 */
export function hasShortcut(task: Task, graph: Graph): boolean {
  const st = initState(task.x, task.spec);
  for (const a of candidates(graph, st, st.hist)) {
    if (a === EXIT) continue;
    const st2 = applyOp(graph, a, st);
    if (st2 === null) continue;
    // submit 自身即「0-op 解」的入口：收尾补上后总步数少一步。
    const cs = _commit(task.family, [], st2.x as number | string);
    if (cs === null) continue;
    const st3 = runPlan(cs.plan, st2);
    if (st3 === null || !accept(task, st3)) continue;
    const shortcutLen = (a === 'submit' ? 0 : 1) + cs.plan.length;
    if (shortcutLen < task.plan_hidden.length) return true;
  }
  return false;
}

/** C.1 `GOAL_PROBE_GOALS`：适格性判定池（sampleGoal 四个单体采样器的全集）。 */
export const GOAL_PROBE_GOALS: readonly Goal[] = Object.freeze([
  { kind: 'parity', target: 0 },
  { kind: 'parity', target: 1 },
  { kind: 'gt', target: 0 },
  { kind: 'gt', target: 5 },
  { kind: 'gt', target: 20 },
  { kind: 'len', min: 1, max: 3 },
  { kind: 'len', min: 2, max: 5 },
]);

/** 判定域按 root 取型别相符子集：sampleGoal 对 Int 只采 parity/gt、对 Str 只采 len。 */
function probeGoals(root: Root): readonly Goal[] {
  return GOAL_PROBE_GOALS.filter((g) =>
    root === 'Int' ? g.kind === 'parity' || g.kind === 'gt' : g.kind === 'len',
  );
}

/** C.1 `goal_probe_hit`（逐目标判定片段）：终值在探针域上可达标记即命中（不看初始态）。 */
export function goalProbeHit(root: Root, plan: readonly string[], goal: Goal): boolean {
  const probes: readonly (number | string)[] = root === 'Int' ? PROBE_INT : PROBE_STR;
  for (const probe of probes) {
    const st = runPlan(plan, initState(probe));
    if (st !== null && goalOk(st.x, { goal })) return true;
  }
  return false;
}

/** 适格性缓释表：同一骨架只全量回测一次（key=_skelId，覆盖配额轮转的重复询问）。 */
const ELIGIBLE_CACHE = new Map<string, boolean>();

/**
 * C.1 `goal_eligible`（R2-P0-2）：该骨架是否存在可达目标 ⇒ goal 族适格。
 * 判定式取「初始不达标 ∧ 终值达标」对（与 instance_goal 的 witness 条件同构）：
 * probe_hit 的弱化式（只看终值达标）会把长度不变类误判适格——它们在 len 目标上
 * 「可达」但永远做不出「改变达标性」的合法任务（计划 C.1 注释对该类的不适格断言
 * 以本式成立）。合取目标不扩大适格域：all 达标 ⇒ 某子句在初始不达标处单独成立。
 */
export function goalEligible(root: Root, skeleton: readonly string[]): boolean {
  // 缓存键复用 _skelId（composition_id 唯一口径，不自建第二份指纹）
  const key = _skelId({ root, plan: skeleton });
  const hit = ELIGIBLE_CACHE.get(key);
  if (hit !== undefined) return hit;
  const witnesses: readonly (number | string)[] = root === 'Int' ? PROBE_INT : PROBE_STR;
  const goals = probeGoals(root);
  // 终值整体回放一次：witness 域 ≪ 目标数 × witness 的逐目标重放。
  const finals: readonly (State | null)[] = witnesses.map((x0) => runPlan(skeleton, initState(x0)));
  let eligible = false;
  outer: for (const goal of goals) {
    for (let i = 0; i < witnesses.length; i++) {
      const st = finals[i];
      if (st === null || st === undefined) continue;
      if (!goalOk(witnesses[i], { goal }) && goalOk(st.x, { goal })) {
        eligible = true;
        break outer;
      }
    }
  }
  ELIGIBLE_CACHE.set(key, eligible);
  return eligible;
}

/**
 * follow 域判定（极小性守卫同口径，R2-P0-3）：扫 witness 域直到某 witness
 * 满足「回放穿验收 ∧ 无严格更短捷径」——instance_follow 拒绝的正是有捷径的
 * witness，判定必须与它同构。Int 全域 PROBE_INT ⇒ 精确；Str 用 PROBE_STR ⇒
 * 保守有界。个别 witness 因单点值碰撞被判捷径不构成不可产（101 域中命中
 * 者总是极少数），全域皆撞才算结构性不可产——这是注册表里 follow 键的语义，
 * 按构造预期恒空，出现即覆盖构造抛错兜底。
 */
function followDomainProducible(sk: Skel): boolean {
  const witnesses: readonly (number | string)[] = sk.root === 'Int' ? PROBE_INT : PROBE_STR;
  const plan = [...sk.plan, 'submit'];
  for (const x of witnesses) {
    const st = runPlan(plan, initState(x));
    if (st === null) continue;
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
    if (accept(task, st) && !hasShortcut(task, GRAPH)) return true;
  }
  return false;
}

/**
 * heldout 已知不可产注册表（模块加载时一次性确定性计算）：goal 两族的键
 * **由 goalEligible 派生**（薄层视图，无第二套判定），follow 两族判出即入册
 * ——按构造全域可产，一旦出现即构造被破坏，由 makeCoverageSplitInfo 抛错兜底。
 */
export const UNPRODUCIBLE_HELDOUT: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  for (const sk of SKELETONS) {
    const id = _skelId(sk);
    if (!HELDOUT_SKELETONS.has(id)) continue;
    if (!goalEligible(sk.root, sk.plan)) {
      keys.add(coverageKey('goal', 'goal', id));
      keys.add(coverageKey('goal', 'goal_verify', id));
    }
    if (!followDomainProducible(sk)) {
      keys.add(coverageKey('follow', 'value', id));
      keys.add(coverageKey('follow', 'verify', id));
    }
  }
  return keys;
})();
