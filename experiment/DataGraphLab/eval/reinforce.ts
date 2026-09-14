/**
 * REINFORCE 对照臂（G2.3）：采样轨迹 → 优势标签 → 写 `reinforce.bin` → Python 批量
 * 策略梯度。梯度数学在 `controller/reinforce_nn.py`（数值梯度已自检），本模块只做
 * C.5 口径的环境交互、优势估计与跨语言搬运——「白手起家」：随机初始化起步，不从 BC
 * checkpoint 热启（A.2 预注册，避免把 imitation bias 带进 RL 对照）。
 *
 * 奖励与优势口径（A.2 钉死）：终局 `+1`（accept）/`0`（否则），无中间奖励；baseline
 * = 最近 200 条 rollout 的滑动均值、只用当前 rollout **之前**的窗口（防自身泄漏）；
 * advantage = reward − baseline。熵正则 β_ent=0.01 在 Python 侧对候选集熵生效。
 *
 * 预算口径：BC 臂训练集总步数 ≈ N × 8；REINFORCE 臂以**环境交互步数**同一预算封顶
 * （`budgetSteps`），超预算即停。单候选步（仅剩 exit 的确定性分支）不进数据集——
 * 它不经过策略决策，纳入只会塞进零梯度噪声。
 */

import { GRAPH, MAX_STEPS } from '../runner/graph.js';
import { rollout } from '../runner/rollout.js';
import { recordFromStep } from '../data/store.js';
import { actionFeatureTable, featurizeRecord } from '../data/records.js';
import {
  writeReinforceBin,
  type ReinforceRow,
} from '../data/reinforce_bin.js';
import { OBS_DIM, type FeatureSet } from '../controller/features.js';
import { Policy } from '../controller/policy.js';
import { makeRng } from '../world/rng.js';
import { taskHash, type Task } from '../schema.js';
import type { Graph } from '../world/operators.js';
import { passAt1, type PassAt1Report } from './metrics.js';

/** A.2 预注册超参：滑动窗口 / 学习率 / 熵权重。 */
export const BASELINE_WINDOW = 200;
export const REINFORCE_LR = 1e-3;
export const BETA_ENT = 0.01;
export const REINFORCE_BATCH = 512;

/** 相邻 rollout 的平均奖励基线（窗口内、排除当前项，防自身泄漏）。 */
export function slidingBaseline(rewards: readonly number[], window = BASELINE_WINDOW): number {
  const n = rewards.length;
  if (n === 0) return 0;
  const start = Math.max(0, n - window);
  let acc = 0;
  for (let i = start; i < n; i++) acc += rewards[i]!;
  return acc / (n - start);
}

export interface CollectOptions {
  readonly seed?: number;
  readonly window?: number;
  readonly maxSteps?: number;
  readonly graph?: Graph;
  /** 环境交互步数封顶（C.8 预算同口径）；缺省不封顶=消费完 tasks 全量（现行行为不变）。 */
  readonly budgetSteps?: number;
}

export interface CollectResult {
  readonly rows: ReinforceRow[];
  readonly rollouts: number;
  readonly steps: number;
  readonly solved: number;
  readonly meanReward: number;
}

/**
 * 采样 rollout 并产优势标签行。非 greedy 采样必须显式 rng（rollout 入口守卫）；
 * 优势按「本 rollout 奖励 − 此前窗口均值」逐 rollout 计算，同一 rollout 所有步共享。
 */
export function collectReinforceRows(
  policy: Policy,
  tasks: readonly Task[],
  opts: CollectOptions = {},
): CollectResult {
  const graph = opts.graph ?? GRAPH;
  const rng = makeRng(opts.seed ?? 0);
  const window = opts.window ?? BASELINE_WINDOW;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const budgetSteps = opts.budgetSteps;
  if (budgetSteps !== undefined && (!Number.isInteger(budgetSteps) || budgetSteps < 1)) {
    throw new Error(`collectReinforceRows: budgetSteps 须为正整数，收到 ${String(budgetSteps)}`);
  }
  const rewards: number[] = [];
  const rows: ReinforceRow[] = [];
  let steps = 0;
  let solved = 0;
  let rollouts = 0;
  let envSteps = 0;
  for (const task of tasks) {
    // 预算封顶以「rollout 为原子单位」判定：已花完预算即停，不再开启新交互（不半途截断）。
    if (budgetSteps !== undefined && envSteps >= budgetSteps) break;
    const res = rollout(policy, graph, task, false, maxSteps, rng);
    rollouts++;
    envSteps += res.trace.length;
    const reward = res.accepted ? 1 : 0;
    const advantage = reward - slidingBaseline(rewards, window);
    rewards.push(reward);
    solved += reward;
    for (let k = 0; k < res.trace.length; k++) {
      const step = res.trace[k]!;
      if (step.candidates.length === 1) continue; // 确定性分支：无策略决策，零学习信号
      const rec = recordFromStep(task, {
        step: k,
        obs: step.obs,
        candidates: step.candidates,
        action: step.action,
      });
      const feat = featurizeRecord(rec);
      rows.push({
        style: feat.style,
        family: feat.family,
        taskHash: taskHash(task),
        stepIndex: k,
        idx: feat.idx,
        val: feat.val,
        candMask: feat.candMask,
        actionIdx: feat.targetIdx,
        advantage,
        reward,
      });
      steps++;
    }
  }
  return {
    rows,
    rollouts,
    steps,
    solved,
    meanReward: rollouts === 0 ? 0 : solved / rollouts,
  };
}

/** 写盘入口（收敛到 `data/reinforce_bin` 唯一契约；特征宽度取自 featureSet）。 */
export function writeReinforceFile(path: string, rows: readonly ReinforceRow[], featureSet: FeatureSet = 'lang'): void {
  writeReinforceBin(path, rows, OBS_DIM[featureSet], actionFeatureTable());
}

/** REINFORCE 臂：终评与训练臂同走 greedy rollout / passAt1，仅权重来源不同。 */
export class ReinforceArm {
  readonly name = 'reinforce' as const;
  readonly policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  solve(task: Task, graph: Graph = GRAPH) {
    return rollout(this.policy, graph, task, true);
  }

  static evaluate(arm: ReinforceArm, tasks: readonly Task[], graph: Graph = GRAPH): PassAt1Report {
    return passAt1(arm.policy, graph, tasks);
  }
}
