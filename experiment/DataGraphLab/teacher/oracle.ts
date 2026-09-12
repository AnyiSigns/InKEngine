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
 */

import { EXIT, applyOp, initState, obsSnapshot, type Graph, type State } from '../world/operators.js';
import { MAX_STEPS, candidates } from '../runner/graph.js';
import { accept } from '../verify/acceptor.js';
import type { Step, Task } from '../schema.js';

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
 * hidden gold plan → 逐步标签。每步 obs 是当刻状态的白名单投影（不重建）、
 * candidates 与 runner 同一唯一口径；末步在验收态上标 EXIT，并先断言
 * `accept(task, st)` 为 true——回放穿不上验收的计划不值得产生标签。
 */
export function oracleTrace(task: Task, graph: Graph): Step[] {
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
    trace.push({ step: trace.length, obs: obsSnapshot(st), candidates: cand, action: opId });
    const next = applyOp(graph, opId, st);
    if (next === null) {
      throw new Error(`oracle: gold 动作 ${opId} 回放进死路（与 candidates 矛盾）`);
    }
    st = next;
  }
  if (!accept(task, st)) {
    throw new Error(`oracle: 计划回放未穿验收（family=${task.family}），拒绝产标签`);
  }
  trace.push({
    step: trace.length,
    obs: obsSnapshot(st),
    candidates: candidates(graph, st, st.hist),
    action: EXIT,
  });
  return trace;
}
