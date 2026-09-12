/**
 * rollout：controller × graph × acceptor 的一次执行轨迹（C.7 逐字语义）。
 *
 * greedy 口径 = 每题只跑一次（A.1 主指标、§11.3「不许多次重试偷分」），全程无采样、
 * 结果确定；非 greedy 采样只服务 REINFORCE 对照臂，必须显式给 seed 化的 rng，缺省
 * 即抛——该守卫收在入口而不是转嫁给 `Policy.act` 内部：单候选分支不经过 policy，
 * 口径不该随当刻候选形状漂移。
 *
 * `accept` 在 exit 当刻（EXIT 被选中之前的状态）上判定：v0 扁平契约世界无弹回边、
 * exit 被选即终止，EXIT 不产生任何状态变换，trace 末步的 obs 就是判验收所用的
 * 验收态。失败收口有两类：选边回放进死路（applyOp null）与步数耗尽仍未碰 exit，
 * 两者都记 accepted=false（超预算不追认，C.4/G2.2 同源口径）。
 */

import { MAX_STEPS, candidates } from './graph.js';
import { EXIT, applyOp, initState, obsSnapshot, type Graph, type State } from '../world/operators.js';
import { accept } from '../verify/acceptor.js';
import type { Rng } from '../world/rng.js';
import type { Policy } from '../controller/policy.js';
import type { Task } from '../schema.js';

/** 轨迹的一行：当刻白名单观测、当刻候选集与该步选中的动作。 */
export interface RolloutStep {
  readonly obs: Readonly<{
    x: unknown;
    answer: unknown;
    verdict: unknown;
    hist: readonly string[];
  }>;
  readonly candidates: readonly string[];
  readonly action: string;
}

export interface RolloutResult {
  readonly trace: readonly RolloutStep[];
  readonly accepted: boolean;
}

/**
 * C.7 主循环：`initState(task.x, task.spec)` 起步，每步候选唯一口径来自
 * `candidates`（B.3）；单候选直接取（该情形只可能是仅剩 exit——exit 恒在候选，
 * 其它节点被契约闸/访问上限滤光），多候选交给 `policy.act`。
 */
export function rollout(
  policy: Policy,
  graph: Graph,
  task: Task,
  greedy = true,
  maxSteps: number = MAX_STEPS,
  rng?: Rng,
): RolloutResult {
  if (!greedy && rng === undefined) {
    throw new Error('rollout: 非 greedy 采样必须显式给 seed 化的 rng');
  }
  let st: State = initState(task.x, task.spec);
  const trace: RolloutStep[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const cand = candidates(graph, st, st.hist);
    const obs = obsSnapshot(st);
    const a = cand.length === 1 ? cand[0]! : policy.act(task.instruction, obs, cand, graph, greedy, rng);
    trace.push({ obs, candidates: cand, action: a });
    if (a === EXIT) return { trace, accepted: accept(task, st) };
    const next = applyOp(graph, a, st);
    if (next === null) return { trace, accepted: false };
    st = next;
  }
  return { trace, accepted: false };
}
