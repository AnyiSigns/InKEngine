/**
 * 先验回落路由（纯函数：无 `__next` 声明时的确定性回落决策）。
 *
 * 执行模型「入口路由局部判定 → 先验参考 → 自治路由」：作用域产物缺 `__next`
 * 声明时，执行层按出厂默认先验（default_scope_priors，可被组织择优覆写）做
 * 确定性回落——先验 hop 形态与 __next 声明同构，本模块把「按入口 trigger 选中
 * 的先验路线 + 游标位置」映射回类型化路由决策；没有命中路线/游标越界 = null
 * （执行层按兜底直收处理，绝不臆造路由）。
 *
 * 纯函数：只消费（路线 + 游标），不携带执行状态；执行层把路线 id + 游标随
 * 执行状态推进（进入新路线时游标置 0，每次回落消费一跳后 +1）。
 */

import { SCOPE_PRIOR_SINK, type ScopePriorHop, type ScopePriorPattern } from '../scopes/scope_priors.js';
import type { RoutingDecision } from './routing_next.js';

/** 单跳 → 类型化路由决策（sink 跳返回 sink 决策；其余按 hop 形态映射）。 */
export function hop_to_decision(hop: ScopePriorHop): RoutingDecision {
  if (hop.shape === SCOPE_PRIOR_SINK) {
    return { kind: 'sink' };
  }
  if (hop.shape === 'delegate' || hop.shape === 'fan_out' || hop.shape === 'fan_in' || hop.shape === 'return') {
    const out: RoutingDecision = {
      kind: hop.shape === 'delegate' ? 'scope' : 'channel',
      target: hop.to,
      channel: hop.shape === 'delegate' ? 'delegate' : hop.shape,
    };
    if (hop.commit !== undefined && hop.commit !== null) out.contract = hop.commit;
    if (hop.count !== undefined) out.count = hop.count;
    return out;
  }
  return { kind: 'sink' };
}

/** 先验路线选择：首跳起点 = 当前作用域，且 trigger 命中（trigger_kinds 空 =
 *  通用路线恒命中；非空须 trigger 包含）。无命中 = null。 */
export function pick_prior_pattern(
  priors: readonly ScopePriorPattern[],
  current_scope: string,
  trigger: string | null,
): ScopePriorPattern | null {
  for (const pattern of priors) {
    if (pattern.hops.length === 0) continue;
    const first = pattern.hops[0]!;
    if (first.from !== current_scope) continue;
    if (pattern.trigger_kinds.length === 0) return pattern;
    if (trigger !== null && pattern.trigger_kinds.includes(trigger)) return pattern;
  }
  return null;
}

/**
 * 无 `__next` 时的先验回落决策：
 *
 * @param priors 先验路线集（缺省素材或组织覆写态）。
 * @param currentScope 当前作用域 id。
 * @param trigger 会话/任务分类标签（可 null = 只看入口作用域）。
 * @param cursor 路线内游标（当前待消费跳下标；进入新路线置 0）。
 * @returns { decision, next_cursor } 或 null（无命中路线 / 游标越界 / 路线已
 *   走完——执行层兜底直收）。
 */
export function fallback_routing(
  priors: readonly ScopePriorPattern[],
  currentScope: string,
  trigger: string | null,
  cursor: number,
): { decision: RoutingDecision; next_cursor: number } | null {
  const pattern = pick_prior_pattern(priors, currentScope, trigger);
  if (pattern === null) return null;
  if (cursor < 0) return null;
  const hops = pattern.hops;
  if (cursor >= hops.length) return null;
  const hop = hops[cursor]!;
  return { decision: hop_to_decision(hop), next_cursor: cursor + 1 };
}
