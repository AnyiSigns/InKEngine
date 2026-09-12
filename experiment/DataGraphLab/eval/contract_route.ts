/**
 * ContractRouteArm（C.7 廉价中档基线，契约路由 v0）：「provides 满足度贪心 + 缺边补边」
 * 的 v0 口径——目标已达标且 submit 可用就先交付；verify 类族缺 verdict 就先补一次
 * check_*（声明的反向链上 verdict 是 submit 验收的前置边）。零学习零泄漏：不 import
 * 任何 teacher/policy 权重，只走 candidates/applyOp/accept 与公开 spec.goal——契约
 * 声明本身就是决策信息，不需要训练。只作对照列：不进 S_ctrl 主指标、不进训练集
 * （held-out 组合上它必然崩，正是「组合能力只能靠训练获得」的反证锚点）。
 * 
 * 决策规则定死（按优先级取第一个命中，v0 口径不再加规则）：
 *   1. family ∈ {goal, goal_verify} 且 goalOk(st.x, task.spec) 且 'submit' ∈ cand → submit；
 *   2. 否则 family ∈ {verify, goal_verify} 且 st.verdict === null 且 cand 含 check_*
 *      （check_parity/check_len）→ 候选序首个 check_*；
 *   3. 否则 'submit' ∈ cand → submit；
 *   4. 否则存在非 EXIT 候选 → 候选序首个；
 *   5. 否则 EXIT。
 *
 * 候选内动作 applyOp 必非 null（candidates 的过滤就是同一道契约闸），死路只从防御
 * 分支进；步数受 MAX_STEPS 封顶，预算耗尽未碰 exit 记 accepted=false（C.4 不追认
 * 口径）。公开面经 eval/arms.ts re-export，本文件的类型 import 只许来自 runner/
 * world/verify。
 */

import { MAX_STEPS, candidates } from '../runner/graph.js';
import { EXIT, applyOp, initState, obsSnapshot, type Graph, type State } from '../world/operators.js';
import { type RolloutResult, type RolloutStep } from '../runner/rollout.js';
import { accept } from '../verify/acceptor.js';
import { goalOk, type Goal } from '../world/goal.js';
import type { Task } from '../schema.js';

export class ContractRouteArm {
  readonly name = 'contract_route' as const;

  /** 逐字确定性：决策只读公开面，同任务两次 solve 的 trace 逐字相同。 */
  solve(task: Task, graph: Graph): RolloutResult {
    let st: State = initState(task.x, task.spec);
    const trace: RolloutStep[] = [];
    for (let step = 0; step < MAX_STEPS; step++) {
      const cand = candidates(graph, st, st.hist);
      const action = this.choose(task, st, cand);
      trace.push({ obs: obsSnapshot(st), candidates: cand, action });
      if (action === EXIT) return { trace, accepted: accept(task, st) };
      const next = applyOp(graph, action, st);
      if (next === null) return { trace, accepted: false };
      st = next;
    }
    return { trace, accepted: false };
  }

  /** 五条规则的单一实现点；cand 已是候选序（graph.ts 的排序遍历）。 */
  private choose(task: Task, st: State, cand: readonly string[]): string {
    const goalFam = task.family === 'goal' || task.family === 'goal_verify';
    const verifyFam = task.family === 'verify' || task.family === 'goal_verify';
    if (goalFam && goalOk(st.x, task.spec as Readonly<{ goal: Goal }>) && cand.includes('submit')) {
      return 'submit';
    }
    if (verifyFam && st.verdict === null) {
      const check = cand.find((c) => c === 'check_parity' || c === 'check_len');
      if (check !== undefined) return check;
    }
    if (cand.includes('submit')) return 'submit';
    return cand.find((c) => c !== EXIT) ?? EXIT;
  }
}
