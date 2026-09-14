/**
 * DAgger 编排（C.5 逐字语义）：on-path 干预式数据采集 + 逐迭代重训。
 *
 * 本模块是 gold 标签与 rollout 唯一相交的地方：`correctGold` 读 `task.plan_hidden`
 * 判定所选动作与下一 gold 动作的分歧，只在「状态恰好落在 gold 前缀」时打标
 * （E.13 标签纪律，off-path 一律不打标）；打标行经 `data/store.recordFromStep`
 * 构造，与 oracle 轨迹共用同一条 obs 白名单（x/answer/verdict/hist）——gold 只进
 * `target` 标签列，绝不进观测或特征。
 *
 * 关键语义是「干预后续跑」：偏离打标后把 gold 动作回放进状态再 continue，状态
 * 回到 gold 前缀，之后的偏离仍是合法 on-path 标签（上限 `maxFixes`，防单条轨迹
 * 过度偏倚数据集）。等价于只教「避免首次错误」、不教错误恢复：偏离打标行的
 * step_index 与前缀观测同构于 oracle 同位置步，与初始 oracle 行天然重合时由
 * `dedup` 收口；真正无监督的是首次偏离之前不会经过的 off-path 状态，故这些
 * 统计只作诊断指标消费，不作晋级门槛。
 *
 * 训练出口不在此实现：唯一训练器是 Python 批量拟合（F.1/F.2 跨语言边界），本模块
 * 不 spawn 任何进程，拟合与 held-out pass@1 评估一律经回调注入。EXIT 参与与算子
 * 完全同源的判定（前缀耗尽而选非 EXIT → 该步 `target=exit`；exit 恒在候选，
 * featurize 的「目标须在候选」不变量不破）。任何采样走 `makeRng(seed)` 单流注入
 * 任务提供器，同 seed 逐字同结果，禁 `Math.random`。
 */

import { MAX_STEPS, GRAPH, candidates } from './graph.js';
import { EXIT, applyOp, initState, obsSnapshot, type Graph, type State } from '../world/operators.js';
import { isOnPath } from '../teacher/oracle.js';
import { dedup, recordFromStep, type StoreRecord } from '../data/store.js';
import { taskHash, type Task } from '../schema.js';
import { makeRng, type Rng } from '../world/rng.js';
import type { Policy } from '../controller/policy.js';

/**
 * 偏离判定的唯一口径：`st.hist`（长度 k）必须是 `plan_hidden` 的前 k 项，否则一律
 * null（off-path 不打标）；on-path 时下一 gold = 计划第 k 个算子，计划耗尽即 EXIT。
 * 所选动作与 gold 一致返回 null（无修正可记），否则返回该 gold 动作作本步标签。
 * 前缀判定复用 `teacher/oracle.isOnPath`，与 oracle 打标同源（E.4 唯一口径）。
 */
export function correctGold(task: Task, st: Readonly<State>, action: string): string | null {
  const k = st.hist.length;
  if (!isOnPath(st.hist, task.plan_hidden)) return null;
  const goldNext = k < task.plan_hidden.length ? task.plan_hidden[k]! : EXIT;
  return action === goldNext ? null : goldNext;
}

/** 一次偏离诊断：哪道题、哪个 gold 位置、该处 gold 动作与控制器实际所选。 */
export interface DaggerDeviation {
  readonly taskHash: string;
  readonly stepIndex: number;
  readonly goldAction: string;
  readonly chosenAction: string;
}

/** rollout 侧诊断统计（供失败语料分析消费；步位分布保留发生序，确定性可复算）。 */
export interface DaggerStats {
  /** 完成的 rollout 总条数。 */
  readonly rollouts: number;
  /** 决策总步数（含被判偏离的步与终止步）。 */
  readonly steps: number;
  /** 偏离步数（= deviations 条数，冗余存放便于逐字核对）。 */
  readonly deviatedSteps: number;
  /** 发生过至少一次偏离的 rollout 条数。 */
  readonly deviatedRollouts: number;
  /** 每条发生偏离的 rollout 的首次偏离步位（occurrence 序）。 */
  readonly firstDeviationDepths: readonly number[];
  /** 每迭代经去重后净增的监督行数。 */
  readonly rowsAddedPerIter: readonly number[];
  /** 按迭代记录的 held-out pass@1；未注入评估回调则该槽为 null。 */
  readonly passAt1PerIter: readonly (number | null)[];
}

export interface DaggerResult {
  readonly policy: Policy;
  readonly iterations: number;
  /** 累积监督行（初始 oracle 行 + 各迭代新增偏离行，步级去重后保序）。 */
  readonly rows: readonly StoreRecord[];
  readonly deviations: readonly DaggerDeviation[];
  readonly stats: DaggerStats;
}

/** 任务提供器：按迭代从 train 域采样 `tasksPerIter` 条任务；随机只能消费注入的 rng。 */
export type TaskProvider = (rng: Rng, count: number, iteration: number) => readonly Task[];

/** 唯一训练出口：聚合后的监督行 + val 行 → 新 policy（真身是 Python 拟合，此处注入）。 */
export type TrainCallback = (rows: readonly StoreRecord[], valRows: readonly StoreRecord[]) => Policy;

/** held-out pass@1 评估回调：只消费 policy，不参与标签采集。 */
export type EvalCallback = (policy: Policy) => number;

export interface DaggerOptions {
  readonly graph?: Graph;
  readonly iterations?: number;
  readonly tasksPerIter?: number;
  readonly maxFixes?: number;
  readonly seed?: number;
  /** 初始 on-path oracle 监督行（不给则从偏离行起步）。 */
  readonly trainRows?: readonly StoreRecord[];
  /** val 行：原样透传给训练回调，永不进 rollout、永不追加。 */
  readonly valRows?: readonly StoreRecord[];
  readonly taskProvider: TaskProvider;
  readonly train: TrainCallback;
  readonly evalPass1?: EvalCallback;
}

function assertCount(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`dagger: ${name} 必须为 ≥${String(min)} 的整数，received ${String(value)}`);
  }
}

/**
 * C.5 主编排：每迭代用当前 policy 贪心 rollout 一批新任务，偏离处收 gold 标签并
 * 干预续跑，行并入训练集后重训一次。单候选（仅剩 exit）也照常咨询 policy——
 * 贪心 argmax 对单候选退化为 exit，与 rollout 捷径口径等价且更贴近 C.5 原文。
 */
export function dagger(policy: Policy, options: DaggerOptions): DaggerResult {
  const graph = options.graph ?? GRAPH;
  const iterations = options.iterations ?? 3;
  const tasksPerIter = options.tasksPerIter ?? 2000;
  const maxFixes = options.maxFixes ?? 4;
  assertCount('iterations', iterations, 0);
  assertCount('tasksPerIter', tasksPerIter, 0);
  assertCount('maxFixes', maxFixes, 1);
  const rng = makeRng(options.seed ?? 0);
  const valRows = options.valRows ?? [];
  let rows: StoreRecord[] = [...(options.trainRows ?? [])];
  const deviations: DaggerDeviation[] = [];
  const firstDeviationDepths: number[] = [];
  const rowsAddedPerIter: number[] = [];
  const passAt1PerIter: Array<number | null> = [];
  let rollouts = 0;
  let steps = 0;
  let deviatedRollouts = 0;

  for (let it = 0; it < iterations; it++) {
    const before = rows.length;
    const batch: StoreRecord[] = [];
    for (const task of options.taskProvider(rng, tasksPerIter, it)) {
      rollouts++;
      const th = taskHash(task);
      let st: State = initState(task.x, task.spec);
      let fixes = 0;
      let seenDeviation = false;
      for (let step = 0; step < MAX_STEPS; step++) {
        steps++;
        const k = st.hist.length;
        const cand = candidates(graph, st, st.hist);
        const obs = obsSnapshot(st);
        const a = policy.act(task.instruction, obs, cand, graph, true);
        const fix = correctGold(task, st, a);
        if (fix === null) {
          if (a === EXIT) break;
          const next = applyOp(graph, a, st);
          if (next === null) break;
          st = next;
          continue;
        }
        if (!seenDeviation) {
          seenDeviation = true;
          deviatedRollouts++;
          firstDeviationDepths.push(k);
        }
        deviations.push({ taskHash: th, stepIndex: k, goldAction: fix, chosenAction: a });
        // teacher='dagger'：偏离打标行标注来源，与 oracle 行同构、可审计区分。
        batch.push(recordFromStep(task, { step: k, obs, candidates: cand, action: fix }, 'dagger'));
        fixes++;
        if (fixes >= maxFixes) break;
        if (fix === EXIT) break;
        const fixed = applyOp(graph, fix, st);
        if (fixed === null) break;
        st = fixed;
      }
    }
    rows = dedup([...rows, ...batch]);
    rowsAddedPerIter.push(rows.length - before);
    policy = options.train(rows, valRows);
    passAt1PerIter.push(options.evalPass1 ? options.evalPass1(policy) : null);
  }

  return {
    policy,
    iterations,
    rows,
    deviations,
    stats: {
      rollouts,
      steps,
      deviatedSteps: deviations.length,
      deviatedRollouts,
      firstDeviationDepths,
      rowsAddedPerIter,
      passAt1PerIter,
    },
  };
}
