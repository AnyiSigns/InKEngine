/**
 * 三臂对照 + 诊断/上界两臂（C.7/D 表）+ evaluateArm 统计口径。
 *
 * 按 style 分别报告，五个臂的定位定死：
 * - `HeuristicArm`（仅 follow）：LEXICON 线性首现顺序的弱词法扫描——`tokens` 后按各义项
 *   首次出现位置升序还原算子序列（中文义项→op id，非英文 id）；同一位置命中多个算子
 *   （共享义项如 `取反`）时不做类型消歧，按 `LEX_OPS_BASE` 固定算子序取第一个（neg 序在
 *   reverse 前，故 `取反` 恒判 neg），从
 *   `initState(task.x, task.spec)` 起逐计划步执行：当前步动作在 candidates 内才 applyOp，
 *   不在则跳到下一步（计划与状态错位时不死循环、不强求走通），计划走完取 EXIT。
 *   非类型感知是 C.7 规格的有意弱化：reverse 任务在渲染为 `取反` 的那一步选错并被跳过，
 *   制造非零失败率，为 trained 臂留出 A.1 的 `S_follow − S_heur ≥ 0.05` 超越空间。
 *   零泄漏为硬约束：全程不触 `plan_hidden`/`expected`（accept 在 exit 当刻只走验收侧）。
 *   goal 族指令无算子义项，LINEAR 启发式不适用 → solve 抛 N/A（goal 列记 N/A，不记 0）。
 * - `RandomArm`：同架构随机权重（`Policy.random(seed)`，REINFORCE 同 seed 随机 init 对照
 *   同源）下界，greedy rollout；同 seed 两次 solve 逐字相同。
 * - `TrainedArm`：训练产物臂（BC/DAgger/checkpoint 注入），`fromWeights` 走 `Policy.load`
 *   的 arch fail-fast 通道；与 passAt1 消费同一 `Policy`。
 * - `PlannerArm`（仅 goal）：**公开规划上界**：`planBfs` 只读 instruction/初始态/公开
 *   spec——goal 族 accept 本就公开，plan_bfs 天然构成其上界；非训练信号（E.13 标签
 *   纪律，产出永不回灌训练/特征）。BFS 保证最短且回放穿验收，故有解必 accepted=true；
 *   确证无解（null）与超预算（throw）记 `{trace: [], accepted: false}`，不 raise。
 *   follow 族 gold 唯一、规划器语义（任意到达验收态）与「跟指令走」不同题，记 N/A。
 * - `ContractRouteArm`（两 style 皆可，实现与五条规则见 contract_route.ts）：廉价中档
 *   基线，零学习零泄漏，只作对照列不进主指标。
 *
 * 主指标单一实现：策略系臂（random/trained）的 pass@1 直接包 metrics.js 的 `passAt1`，
 * `ci95` 一律 import metrics.js、禁本地重写（replay 臂的 passRate/ci95 也走同一函数）。
 * greedy pass@1 每题只跑一次（A.1 主指标、§11.3 不许多次重试偷分）；rollout、
 * planBfs、accept、分词口径（tokens/findSequence/senseTokens/LEXICON/LEX_OPS_BASE）
 * 全部 import 唯一口径、不改写复刻——弱扫描只在「同位选算子」环节弱化。
 */

import { MAX_STEPS, candidates } from '../runner/graph.js';
import {
  EXIT,
  LEX_OPS_BASE,
  applyOp,
  initState,
  obsSnapshot,
  type Graph,
  type State,
} from '../world/operators.js';
import { rollout, type RolloutResult, type RolloutStep } from '../runner/rollout.js';
import { accept } from '../verify/acceptor.js';
import { LEXICON } from '../world/lexicon.js';
import { findSequence, senseTokens, tokens } from '../world/tokenize.js';
import { planBfs } from '../teacher/search.js';
import { Policy, type HeadTag } from '../controller/policy.js';
import type { FeatureSet } from '../controller/features.js';
import { ci95, passAt1 } from './metrics.js';
import type { Style, Task } from '../schema.js';
import { ContractRouteArm } from './contract_route.js';

export { ContractRouteArm };

/** 报告臂名，与 C.7 三臂表及对照/上界臂一一对应。 */
export type ArmName = 'heuristic' | 'random' | 'trained' | 'planner' | 'contract_route';

/** evaluateArm 的产物（C.8：每个 (style, arm) 一列；applicable=false 即 N/A 占位）。 */
export interface ArmReport {
  readonly arm: string;
  readonly style: 'follow' | 'goal';
  readonly applicable: boolean;
  readonly solved: number;
  readonly total: number;
  readonly passRate: number;
  readonly ci95: readonly [number, number];
}

/** evaluateArm 接受的臂形状：五臂都严格实现它，策略系臂另带 policy 供 passAt1 复用。 */
export interface EvalArm {
  readonly name: ArmName;
  readonly policy?: Policy;
  solve(task: Task, graph: Graph): RolloutResult;
}

/** 沿公开 plan 逐步回放到 EXIT：cand/obs 与 rollout 同一口径记录，失败（死路/超预算）
 *  提前收口 accepted=false。heuristic 与 planner 共用这段机械（决策面在上游，这里是
 *  纯执行器），accept 仍在 exit 当刻状态上判定（rollout 同源语义）。 */
function runPublicPlan(
  plan: readonly string[],
  task: Task,
  graph: Graph,
): RolloutResult {
  let st: State = initState(task.x, task.spec);
  const trace: RolloutStep[] = [];
  for (let step = 0; step < MAX_STEPS && trace.length < plan.length; step++) {
    const cand = candidates(graph, st, st.hist);
    const action = plan[trace.length]!;
    trace.push({ obs: obsSnapshot(st), candidates: cand, action });
    const next = applyOp(graph, action, st);
    if (next === null) return { trace, accepted: false };
    st = next;
  }
  if (trace.length !== plan.length) return { trace, accepted: false };
  const cand = candidates(graph, st, st.hist);
  trace.push({ obs: obsSnapshot(st), candidates: cand, action: EXIT });
  return { trace, accepted: accept(task, st) };
}

/**
 * 弱词法扫描（C.7 启发式臂的计划还原口径）：`tokens` 切分后，收集 LEXICON 各义项在
 * token 流中的首次命中位置，按位置升序逐位定一个算子；同一位置命中多个算子（共享义项
 * `取反` 同时命中 neg/reverse）时**不做类型消歧**、也不读 `task.root`，一律取
 * `LEX_OPS_BASE` 固定算子序的最小者（neg）——与 `parseRecipe` 的类型感知口径刻意分道：
 * 渲染成 `取反` 的 reverse 步会被选成 neg、在 Str 状态上不进 candidates 而整步跳过，
 * 由此产生非零失败率（弱臂之「弱」即在此，分词与义项匹配仍走 world 层唯一口径）。
 */
function weakLexicalPlan(instr: string): string[] {
  const toks = tokens(instr);
  const byFirst = new Map<number, string[]>();
  for (const opId of LEX_OPS_BASE) {
    for (const sense of LEXICON[opId]!) {
      const first = findSequence(toks, senseTokens(sense));
      if (first < 0) continue;
      const group = byFirst.get(first) ?? [];
      if (!group.includes(opId)) group.push(opId);
      byFirst.set(first, group);
    }
  }
  const plan: string[] = [];
  for (const first of [...byFirst.keys()].sort((a, b) => a - b)) {
    // tie-break 只看 LEX_OPS_BASE 序，与状态类型无关；map 收集已保证组内首现序稳定。
    let chosen = byFirst.get(first)![0]!;
    for (const id of byFirst.get(first)!) {
      if (LEX_OPS_BASE.indexOf(id) < LEX_OPS_BASE.indexOf(chosen)) chosen = id;
    }
    plan.push(chosen);
  }
  return plan;
}

/** 启发式臂：LEXICON 线性首现顺序弱扫描重放（仅 follow；goal 时抛 N/A）。 */
export class HeuristicArm {
  readonly name = 'heuristic' as const;

  solve(task: Task, graph: Graph): RolloutResult {
    if (task.style !== 'follow') throw new Error('N/A: HeuristicArm 仅对配方族（follow）适用');
    const plan = weakLexicalPlan(task.instruction);
    let st: State = initState(task.x, task.spec);
    const trace: RolloutStep[] = [];
    for (const opId of plan) {
      const cand = candidates(graph, st, st.hist);
      if (!cand.includes(opId)) continue;
      const next = applyOp(graph, opId, st);
      if (next === null) continue;
      trace.push({ obs: obsSnapshot(st), candidates: cand, action: opId });
      st = next;
    }
    const cand = candidates(graph, st, st.hist);
    trace.push({ obs: obsSnapshot(st), candidates: cand, action: EXIT });
    return { trace, accepted: accept(task, st) };
  }
}

/** 随机臂：同架构随机权重贪心 rollout（下界 sanity，期望 ≈ 候选数^-步数）。 */
export class RandomArm {
  readonly name = 'random' as const;
  readonly policy: Policy;

  constructor(seed: number, featureSet?: FeatureSet) {
    this.policy = Policy.random(seed, featureSet ?? 'lang');
  }

  solve(task: Task, graph: Graph): RolloutResult {
    return rollout(this.policy, graph, task, true);
  }
}

/** 训练臂：Policy 注入（BC/DAgger/REINFORCE 产物同一入口），greedy rollout。 */
export class TrainedArm {
  readonly name = 'trained' as const;
  readonly policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  /** weights.json → Policy.load（arch 版本不符 fail-fast，禁跨版本静默加载，F.2）。 */
  static fromWeights(path: string, expect?: { featureSet?: FeatureSet; head?: HeadTag }): TrainedArm {
    return new TrainedArm(Policy.load(path, expect));
  }

  solve(task: Task, graph: Graph): RolloutResult {
    return rollout(this.policy, graph, task, true);
  }
}

/** 规划臂：plan_bfs 公开规划上界（仅 goal；follow 时抛 N/A），非训练信号。 */
export class PlannerArm {
  readonly name = 'planner' as const;

  solve(task: Task, graph: Graph): RolloutResult {
    if (task.style !== 'goal') throw new Error('N/A: PlannerArm 仅对目标族（goal）适用');
    let plan: string[] | null;
    try {
      plan = planBfs(task, graph);
    } catch {
      return { trace: [], accepted: false };
    }
    if (plan === null) return { trace: [], accepted: false };
    return runPublicPlan(plan, task, graph);
  }
}

/** 臂 × style 的 N/A 判定（C.7 表：goal 族 Heuristic 记 N/A；Planner 只对 goal 适用）。 */
function isNotApplicable(arm: ArmName, style: Style): boolean {
  return (arm === 'heuristic' && style === 'goal') || (arm === 'planner' && style === 'follow');
}

function zeroReport(arm: string, style: Style): ArmReport {
  return { arm, style, applicable: false, solved: 0, total: 0, passRate: 0, ci95: ci95(0, 0) };
}

/**
 * evaluateArm 统计口径：只评 `task.style === style` 的任务，greedy 每题一次。
 * 策略系臂（random/trained）直接包 metrics.js `passAt1`——主指标单一实现，CI 也走
 * 同一 ci95；replay 臂（heuristic/planner/contract_route）自行数 accepted，但
 * passRate/ci95 仍 import 同一实现。N/A 情形不跑任何 solve（applicable=false，
 * solved/total=0），与「跑了全错」的 0 分严格区分。
 */
export function evaluateArm(
  arm: EvalArm,
  tasks: readonly Task[],
  graph: Graph,
  style: Style,
): ArmReport {
  if (isNotApplicable(arm.name, style)) return zeroReport(arm.name, style);
  const subset = tasks.filter((t) => t.style === style);
  if (arm.name === 'random' || arm.name === 'trained') {
    if (!arm.policy) throw new Error(`evaluateArm: ${arm.name} 臂缺少 policy`);
    const r = passAt1(arm.policy, graph, subset);
    return { ...r, arm: arm.name, style, applicable: true };
  }
  let solved = 0;
  for (const task of subset) {
    if (arm.solve(task, graph).accepted) solved++;
  }
  const total = subset.length;
  const passRate = total === 0 ? 0 : solved / total;
  return { arm: arm.name, style, applicable: true, solved, total, passRate, ci95: ci95(passRate, total) };
}

/** scale.ts 的列定义便捷量：一次 evaluateArm 全臂 × 两 style（C.8 长表生成入口）。 */
export function defaultArms(randomSeed = 0, trained: Policy | null = null): readonly EvalArm[] {
  const arms: EvalArm[] = [
    new HeuristicArm(),
    new RandomArm(randomSeed),
    new PlannerArm(),
    new ContractRouteArm(),
  ];
  if (trained !== null) arms.push(new TrainedArm(trained));
  return arms;
}
