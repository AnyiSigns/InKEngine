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
 *    极小性守卫，R2-P0-3 删任意步版：单步替换 + 删任意 ≥1 骨架步的子序列回放，过验收
 *    且**严格短于**金计划 → 非最小）。「严格短于」是必要限定：深度 1 骨架自己的算子+
 *    提交恰为金计划本身，判捷径会把整个深度 1 follow 域清空；真捷径例子是 [mod7] 开头
 *    × x∈0..6（起点直接 submit 即达标）与 mod7/cond 类删中间步型值碰撞冗余（原单步
 *    检查只挡「换首步」，删步型漏网——G2.2 0.90 来源，本版补齐）。
 * ③ `UNPRODUCIBLE_HELDOUT`——heldout 报告注册表，goal 两族的键**由 goalEligible 派生**
 *    （薄层，不再是第二套判定）：goal 族 witness 已要求初始不达标，submit/echo 单步
 *    必然失手 ⇒ hasShortcut 在适格对上是死项 ⇒ 「适格」与「可产」同域，注册表退化为
 *    适格性的 heldout 视图；follow 两族键 = **结构性非最小**（全域 witness 均判捷径，
 *    删任意步守卫命中）：Int 探针即采样全域 ⇒ 精确；Str 用确定性采样（200 条，
 *    探针十串对该类失真，实测 rate-1.0 骨架探针可干净而采样域全域判捷径）。判出即
 *    入册为合法 heldout 视图，由覆盖构造按可产域声明并显式上报（与 goal 族不适格
 *    同口径，键 = `style:family:composition_id`，manifest/报告可直接消费）。
 */

import { PROBE_INT, PROBE_STR, SKELETONS, _skelId, type Skel } from './skeletons.js';
import { HELDOUT_SKELETONS } from './splits.js';
import { accept } from '../verify/acceptor.js';
import { GRAPH, candidates } from '../runner/graph.js';
import {
  ASCII_ALPHABET,
  applyOp,
  emod,
  EXIT,
  initState,
  runPlan,
  type Graph,
  type State,
} from '../world/operators.js';
import { crc32 } from '../world/hash.js';
import { makeRng } from '../world/rng.js';
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
  // R5 轨迹约束：follow 族（value/verify）spec 增公开字段 trace = 含收尾终算子的渲染
  // 序列（机读指令规格）。验收 = 原判定 ∧ hist == trace 精确匹配；goal 族不加（多解合法）。
  // trace 属公开 spec 面（与 parity/length/goal 同层），控制器特征白名单不含 spec。
  if (family === 'value' || family === 'verify') spec.trace = [...plan];
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
 * C.1 `has_shortcut`（R2-P0-3 删任意步版）：follow 族极小性守卫——存在更短的合法
 * 计划过验收 ⇒ 任务非最小，换 witness。两类判定，任一命中即真：
 * ① 单步替换（R2-P0-3 保留）：初始态 → 任一候选算子（含直接 submit 的 0-op 解）→
 *    收尾提交，过验收且**严格短于**金计划；
 * ② 删任意 ≥1 个骨架步：gold 骨架段（n≤5 ⇒ 真子序列 ≤31 个）逐条回放 + 收尾提交，
 *    过验收且**严格短于**金计划——单步替换只挡「换首步」，删中间步型（mod7/cond
 *    类值碰撞冗余）由本段补齐（G2.2 0.90 的实测来源）。
 * 收尾提交按族补 `submit(+check_*)`：verify 家族的 verdict 由 _commit 从终值现场
 * 派生，与验收指纹一致 ⇒ 捷径判定与 check_* 的 pass:hash8 语义天然兼容。
 * R5 轨迹约束后语义（README R5「hasShortcut 按定义恒 false（保留安全网）」）：
 * follow 族验收要求 hist == spec.trace 精确匹配，任何更短捷径的 hist 必 ≠ gold
 * trace ⇒ 必被 accept 拒 ⇒ 本判定对 follow 族恒 false。保留为安全网：若 R5 后
 * 验收被放宽或 trace 语义变更，这里立即恢复抓非最小；generator 的调用点
 * （instanceFollow）与实现均不删。
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
  // ② 删任意步：gold 骨架段（plan_hidden 剥收尾提交）真子序列全枚举，掩码 0..2^n-2
  // （含删光 = 直接收尾，与 ① 的 submit 分支同判，保持枚举完备）；删步可能破坏类型
  // 合法（如 [upper,str_len] 删 str_len 后接 Int 算子失配），runPlan 返回 null 即跳过。
  const suffix = task.family === 'value' ? 1 : 2; // 收尾段长：value 族仅 submit 一步
  const ops = task.plan_hidden.slice(0, task.plan_hidden.length - suffix);
  for (let mask = 0, full = 1 << ops.length; mask < full - 1; mask++) {
    const sub: string[] = [];
    for (let i = 0; i < ops.length; i++) {
      if ((mask & (1 << i)) !== 0) sub.push(ops[i]!);
    }
    const st2 = runPlan(sub, st);
    if (st2 === null) continue;
    const cs = _commit(task.family, [], st2.x as number | string);
    if (cs === null) continue;
    const st3 = runPlan(cs.plan, st2);
    if (st3 === null || !accept(task, st3)) continue;
    if (sub.length + cs.plan.length < task.plan_hidden.length) return true;
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

/** Str 采样域抽样预算（确定性种子，与 instanceFollow 重试上限同尺度；命中即早退）。 */
const FOLLOW_STR_SAMPLES = 200;

/** follow 结构性非最小缓释表：同一骨架只全量回测一次（key=_skelId，生成/注册表共用）。 */
const FOLLOW_CACHE = new Map<string, boolean>();

/** Str 采样 witness（与 sampleValue 同构：长度 1..8、字母 a-h），种子随骨架指纹分散。 */
function sampleStrWitnesses(sk: Skel): readonly string[] {
  const rng = makeRng(crc32(_skelId(sk)));
  const out: string[] = [];
  for (let s = 0; s < FOLLOW_STR_SAMPLES; s++) {
    let v = '';
    for (let i = 0, n = rng.randint(1, 8); i < n; i++) v += ASCII_ALPHABET[rng.randint(0, 7)];
    out.push(v);
  }
  return out;
}

/**
 * follow 域结构性非最小判定（R2-P0-3 删任意步版，按骨架缓存一次）：扫 witness 域
 * 直到某 witness 满足「回放穿验收 ∧ 无严格更短捷径」——instance_follow 拒绝的正是
 * 有捷径的 witness，判定必须与它同构。Int 用 PROBE_INT（= 采样全域 -50..50）⇒
 * 精确；Str 用确定性全域采样（FOLLOW_STR_SAMPLES 条，与 sampleValue 同构的域）⇒
 * 探针十串对该类失真（rate-1.0 的 Str 骨架探针可干净而采样域全域判捷径，反之探针
 * 良 witness 是 1/19M 密度的孤立点，不构成可产性）故 Str 不设探针捷径。Str 采样域
 * 需 **≥2 条**无捷径 witness 才判可产：单条命中 = 采样运气（实际捷径率 ≈0.995+，
 * 与 instanceFollow 同尺度的重试预算内几乎产不出），与全域判捷径同归入结构性非
 * 最小。判定结果 ⇒ heldout 键入册为合法视图（覆盖构造按可产域声明并显式上报），
 * 生成侧短路 null（防空烧预算）。
 */
export function followUnproducible(sk: Skel): boolean {
  const key = _skelId(sk);
  const hit = FOLLOW_CACHE.get(key);
  if (hit !== undefined) return hit;
  const witnesses: readonly (number | string)[] =
    sk.root === 'Int' ? PROBE_INT : sampleStrWitnesses(sk);
  const plan = [...sk.plan, 'submit'];
  let goods = 0;
  for (const x of witnesses) {
    const st = runPlan(plan, initState(x));
    if (st === null) continue;
    const task: Task = {
      style: 'follow',
      family: 'value',
      instruction: '',
      x,
      // R5 轨迹约束：临时任务同样携带公开 trace（= 金计划序列）。验收 = 值 ∧
      // hist == trace，金计划回放恒成立 → 结构性非最小不再构成缺陷（更短替代
      // 按定义不合法），followUnproducible 退化为"金计划回放可穿即可产"。
      spec: { trace: plan },
      expected: st.x as number | string,
      plan_hidden: plan,
      root: sk.root,
      plan_hash: '',
      composition_id: '',
      split: 'heldout',
    };
    if (accept(task, st) && !hasShortcut(task, GRAPH)) {
      if (sk.root === 'Int' || ++goods >= 2) {
        FOLLOW_CACHE.set(key, false);
        return false;
      }
    }
  }
  FOLLOW_CACHE.set(key, true);
  return true;
}

/**
 * heldout 已知不可产注册表（模块加载时一次性确定性计算）：goal 两族的键
 * **由 goalEligible 派生**（薄层视图，无第二套判定），follow 两族的键 = 结构性
 * 非最小（followUnproducible 同口径，Int 精确 / Str 确定性采样保守）——两者同为
 * 合法 heldout 视图，由 makeCoverageSplitInfo 按可产域声明、键显式上报。
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
    if (followUnproducible(sk)) {
      keys.add(coverageKey('follow', 'value', id));
      keys.add(coverageKey('follow', 'verify', id));
    }
  }
  return keys;
})();
