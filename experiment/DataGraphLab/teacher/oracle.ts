/**
 * Oracle teacher（on-path 逐步标签的唯一来源）：hidden gold plan → (observation, target_action)。
 *
 * 零 API、无限量，是 BC/SFT 的主标签；标签纪律：只在状态恰好落在 gold 前缀上时打标
 * （`isOnPath` 是判定源，DAgger 侧复用同一口径）。读 `plan_hidden` 与 `expected` 是
 * teacher 侧专属职责——产物 Step 的 obs 经 `obsSnapshot` 白名单投影，spec/expected
 * 绝无进入路径；轨迹由 `data/store.ts` 落盘时同样不写隐藏量（provenance 侧 meta
 * 只带 hash，不带原值）。
 *
 * 每步断言链 = 三重自检：gold op 必须在 candidates（契约/访问上限/可达性一致），
 * applyOp 必须非 null（回放不死路），末步前 `accept` 必须为 true（生成 G0.2 的前提
 * 在 teacher 侧再验一遍）。任一断言失败即抛错，绝不静默产坏标签。
 *
 * 标签软化（Phase 2 门禁，§6）：目标族（goal/goal_verify）多解合法，one-hot oracle
 * 标签近乎任选（safe_action_conflict_rate≈1.0，P75 预注册阈值已满足）——故目标族
 * 每步附 `safeTargets`（经 `data/conflict_bfs.safeActionSet` 判定的「仍通向验收的
 * 动作集」，gold 按构造保证强制并入）；配方族单解（spec.trace），保持 one-hot。
 */

import { EXIT, applyOp, initState, obsSnapshot, type Graph, type State } from '../world/operators.js';
import { MAX_STEPS, candidates } from '../runner/graph.js';
import { accept } from '../verify/acceptor.js';
import { safeActionSet } from '../data/conflict_bfs.js';
import type { Family, Step, Task } from '../schema.js';

/** 目标族判定的唯一口径（goal/goal_verify 多解合法，才谈得上软化）。 */
export function isGoalFamily(family: Family): boolean {
  return family === 'goal' || family === 'goal_verify';
}

/**
 * safeActionSet 的 BFS 预算口径：500 展开。值域去重（x/answer/verdict）下 500 预算
 * 捕获统计集平均安全动作集的 ~65%（8.52/4000 上限 vs 5.54/500），是覆盖/成本
 * 折中点（29ms/step）；截断保守——漏报安全动作只会让软化标签更接近 one-hot，
 * 绝不引入未证动作。训练规模下按 §6 用 worker_threads 并行生成。
 * 冒烟实证：均匀软化（所有安全动作等权）令 greedy argmax 游走（S_goal(10k)
 * 0.55→0.29、steps_over_shortest 2.3→6.4），故标签 = **深度倒数权重**（越早通向
 * 验收的动作权重越高，gold 因构造保证必最短路径之一而居首）——保留「多解皆可」
 * 的宽容，同时维持 argmax 的判别力。
 */
export const SAFE_ACTION_BUDGET = 500;

/**
 * 状态是否落在 gold 前缀上：`hist` 必须是 `plan` 的前缀（等长或更短），超长或错位
 * 即 off-path。off-path 一律不打标（C.3/E.13 标签纪律的判定源）。
 */
export function isOnPath(hist: readonly string[], plan: readonly string[]): boolean {
  if (hist.length > plan.length) return false;
  for (let k = 0; k < hist.length; k++) {
    if (hist[k] !== plan[k]) return false;
  }
  return true;
}

/**
 * 目标族软化标签（Phase 2 门禁，§6）：该 on-path 状态下仍通向验收的动作集，按
 * 「到最近验收态的最短剩余步数」携带深度。`safeActionSet` 是保守下界（预算截断
 * 只少报不谎报），gold 按 oracle 构造保证（回放穿验收）强制并入——标签分布因此
 * 必含 gold；gold 深度 = 剩余 gold 步数（其所在路径必通验收，无需 BFS 证明）。
 * 返回 safe 按字典序稳定、depths 与之逐位对应（软化分布 = 深度倒数归一，见
 * records_bin v4 头注与 train_nn `_y_from_mask`）。
 */
export function safeTargetsFor(task: Task, graph: Graph, st: State): { safe: string[]; depths: number[] } {
  const res = safeActionSet(graph, task, st, SAFE_ACTION_BUDGET);
  const k = st.hist.length;
  const gold = k < task.plan_hidden.length ? task.plan_hidden[k]! : EXIT;
  const goldDepth = gold === EXIT ? 0 : task.plan_hidden.length - k;
  const set = new Set(res.safe);
  set.add(gold);
  const safe = [...set].sort();
  const depths = safe.map((a) => (a === gold ? goldDepth : (res.depths[a] ?? goldDepth)));
  return { safe, depths };
}

/**
 * hidden gold plan → 逐步标签。每步 obs 是当刻状态的白名单投影（不重建）、
 * candidates 与 runner 同一唯一口径；末步在验收态上标 EXIT，并先断言
 * `accept(task, st)` 为 true——回放穿不上验收的计划不值得产生标签。
 * 目标族每步附 `safeTargets`（软化标签，gold 强制在内）。`soften=false` 时
 * 跳过 safeTargets BFS（val/stat 集只需 one-hot gold 做选点/诊断，省生成成本）。
 */
export function oracleTrace(task: Task, graph: Graph, soften = true): Step[] {
  let st: State = initState(task.x, task.spec);
  const trace: Step[] = [];
  if (task.plan_hidden.length + 1 > MAX_STEPS) {
    throw new Error(`oracle: 计划长度 ${String(task.plan_hidden.length)} 加 EXIT 超出 MAX_STEPS`);
  }
  for (const opId of task.plan_hidden) {
    const cand = candidates(graph, st, st.hist);
    if (!cand.includes(opId)) {
      throw new Error(`oracle: gold 动作 ${opId} 不在候选 ${JSON.stringify(cand)}（契约/访问上限自检失败）`);
    }
    if (opId === EXIT) {
      throw new Error('oracle: EXIT 不得出现在 plan_hidden 内（终算子只在收尾追加）');
    }
    const soft = soften && isGoalFamily(task.family) ? safeTargetsFor(task, graph, st) : undefined;
    trace.push({
      step: trace.length,
      obs: obsSnapshot(st),
      candidates: cand,
      action: opId,
      ...(soft !== undefined ? { safeTargets: soft.safe, safeDepths: soft.depths } : {}),
    });
    const next = applyOp(graph, opId, st);
    if (next === null) {
      throw new Error(`oracle: gold 动作 ${opId} 回放进死路（与 candidates 矛盾）`);
    }
    st = next;
  }
  if (!accept(task, st)) {
    throw new Error(`oracle: 计划回放未穿验收（family=${task.family}），拒绝产标签`);
  }
  const softFinal = soften && isGoalFamily(task.family) ? safeTargetsFor(task, graph, st) : undefined;
  trace.push({
    step: trace.length,
    obs: obsSnapshot(st),
    candidates: candidates(graph, st, st.hist),
    action: EXIT,
    ...(softFinal !== undefined ? { safeTargets: softFinal.safe, safeDepths: softFinal.depths } : {}),
  });
  return trace;
}
