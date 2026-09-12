/**
 * 通道收口的可执行验收（B.4/C.2 唯一口径）。
 *
 * 验收只读两类输入：任务的公开侧（family/expected/spec，经 acceptorView 投影）
 * 与运行时状态的产物字段（answer/verdict）。expected 与 spec.goal 只在此处可见，
 * 绝不进入 obs 或任何控制器特征（白名单红线）。家族决定判定方式：配方族
 * （value/verify）按值深等比对 expected；目标族（goal/goal_verify）按公开目标
 * 谓词判定，多解可接受。verify/goal_verify 是双生产者族，answer 与 verdict 必须
 * 分别由 submit 与 check_* 通道供给，错误生产者喂不饱验收。acceptChannelled 在此
 * 之上先按 CHANNEL 只读本族允许的产物字段，字段缺失（含 null）即返回 missing
 * 原因码，再把判定交给 accept，不重复实现第二份判定。
 */

import { deepEq } from '../world/types.js';
import { goalOk, type Goal } from '../world/goal.js';
import type { State } from '../world/operators.js';
import type { Family, Task, Verdict } from '../schema.js';

/** 通道表（B.4 唯一）：value/goal 单生产者，verify/goal_verify 双生产者。 */
export const CHANNEL: Readonly<Record<Family, readonly string[]>> = Object.freeze({
  value: Object.freeze(['answer']),
  verify: Object.freeze(['answer', 'verdict']),
  goal: Object.freeze(['answer']),
  goal_verify: Object.freeze(['answer', 'verdict']),
});

/** 验收可见侧：只含 family/expected/spec，其余字段一律不参与判定。 */
export function acceptorView(task: Task): {
  family: Family;
  expected: number | string;
  spec: Readonly<Record<string, unknown>>;
} {
  return { family: task.family, expected: task.expected, spec: task.spec };
}

/**
 * B.4 唯一签名：answer 为 null 即拒；配方族深等 expected，目标族走 goalOk
 * （类型不匹配返回 false，不抛异常）；未知 family 抛错，不静默放过。
 */
export function accept(task: Task, state: State): boolean {
  const av = acceptorView(task);
  const ans = state.answer;
  if (ans === null || ans === undefined) return false;
  let ok: boolean;
  if (av.family === 'value' || av.family === 'verify') {
    ok = deepEq(ans, av.expected);
  } else if (av.family === 'goal' || av.family === 'goal_verify') {
    ok = goalOk(ans, av.spec as Readonly<{ goal: Goal }>);
  } else {
    throw new Error(`acceptor: 未知 family ${String(av.family)}`);
  }
  if (av.family === 'verify' || av.family === 'goal_verify') {
    ok = ok && state.verdict === 'pass';
  }
  return ok;
}

/** C.2：先按 CHANNEL 只读本族产物字段，缺失即 missing 原因码，再交给 accept。 */
export function acceptChannelled(task: Task, state: State): Verdict {
  for (const field of CHANNEL[task.family]) {
    const v = state[field];
    if (v === null || v === undefined) return { passed: false, reason: `missing:${field}` };
  }
  const ok = accept(task, state);
  return { passed: ok, reason: ok ? 'accepted' : 'rejected' };
}
