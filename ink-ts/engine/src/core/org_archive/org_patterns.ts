/**
 * 组织模式数据面（OrgPattern：轨迹 → scope×channel 统计的对照单元）。
 *
 * 组织档案的跨会话对照单元 = 组织模式（scope×channel 组合，§六）：
 *
 * - 转场模式 transition：一次「scope A →通道→ scope B」（delegate/fan_out/
 *   fan_in/return 形态 + 提交契约），由轨迹的单个 hop 派生；
 * - 链模式 chain：两跳连续的转场「A → R → C」（中继作用域 R 被穿过），由
 *   相邻 hop 对派生——短路化（跳过中继直连）与委托/并行决策的择优信号源；
 * - 并行档：hop.count（并行路数）随转场统计聚合（fan_out/fan_in 的平均扇出），
 *   供「并行几路」类决策参照；
 * - 作用域使用：每次执行经过的作用域集合（入口 + 各跳目标），含收尾作用域
 *   （终态归属），供作用域资产级择优（降权/下架候选）。
 *
 * 词汇约束：作用域引用与通道形态/提交契约一律复用 Wave-1 作用域目录与通道
 * 数据面词表（scope 目录 role/id、channel shape/commit），不在此另立第二套
 * 枚举；hop 缺省 commit 按全量回传归一（与通道缺省契约同口径）。
 */

import {
  CHANNEL_COMMITS,
  CHANNEL_COMMIT_FULL,
  CHANNEL_SHAPES,
  type ChannelCommit,
  type ChannelShape,
} from '../channels/channel_spec.js';
import type { ExecutionTrail, TrailHop } from './execution_trail.js';

/** 转场模式（单跳 scope×channel 组合）。 */
export interface OrgTransitionPattern {
  from: string;
  to: string;
  shape: ChannelShape;
  commit: ChannelCommit;
  /** 并行路数（hop 携带时记录；统计聚合为并行档均值）。 */
  fan_width: number | null;
}

/** 链模式（两跳连续转场 A→R→C；R = 中继作用域）。 */
export interface OrgChainPattern {
  a: string;
  mid: string;
  c: string;
  shape1: ChannelShape;
  commit1: ChannelCommit;
  shape2: ChannelShape;
  commit2: ChannelCommit;
}

/** 作用域使用观察（入口 + 各跳目标去重；terminal = 本次执行收尾作用域）。 */
export interface TrailScopeUsage {
  scopes: string[];
  terminal: string;
}

/** hop 提交契约归一（缺省 = 全量回传，与通道缺省契约同口径）。 */
export function hop_commit(hop: TrailHop): ChannelCommit {
  return hop.commit ?? CHANNEL_COMMIT_FULL;
}

/** hop 并行档归一（fan_out/fan_in 之外的形态不携带并行档）。 */
export function hop_fan_width(hop: TrailHop): number | null {
  return hop.count ?? null;
}

/** 稳定可逆的转场模式键（JSON 数组编码：id 可含分隔符也不歧义）。 */
export function transition_pattern_key(
  from: string,
  to: string,
  shape: ChannelShape,
  commit: ChannelCommit,
): string {
  return JSON.stringify(['transition', from, to, shape, commit]);
}

/** 稳定可逆的链模式键。 */
export function chain_pattern_key(
  a: string,
  mid: string,
  c: string,
  shape1: ChannelShape,
  commit1: ChannelCommit,
  shape2: ChannelShape,
  commit2: ChannelCommit,
): string {
  return JSON.stringify(['chain', a, mid, c, shape1, commit1, shape2, commit2]);
}

/** 从转场模式构建键（便捷重载，供查询/去重用）。 */
export function transition_key_of(pattern: {
  from: string;
  to: string;
  shape: ChannelShape;
  commit?: ChannelCommit;
}): string {
  return transition_pattern_key(pattern.from, pattern.to, pattern.shape, pattern.commit ?? CHANNEL_COMMIT_FULL);
}

/** 从链模式构建键（便捷重载，供查询/去重用）。 */
export function chain_key_of(pattern: {
  a: string;
  mid: string;
  c: string;
  shape1: ChannelShape;
  commit1?: ChannelCommit;
  shape2: ChannelShape;
  commit2?: ChannelCommit;
}): string {
  return chain_pattern_key(
    pattern.a,
    pattern.mid,
    pattern.c,
    pattern.shape1,
    pattern.commit1 ?? CHANNEL_COMMIT_FULL,
    pattern.shape2,
    pattern.commit2 ?? CHANNEL_COMMIT_FULL,
  );
}

/** 转场模式键解码（非法键 = null；用于读取/审计证据回显）。 */
export function decode_transition_key(
  key: string,
): { from: string; to: string; shape: ChannelShape; commit: ChannelCommit } | null {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== 'transition') return null;
  const [, from, to, shape, commit] = parts;
  if (
    typeof from !== 'string' || typeof to !== 'string'
    || typeof shape !== 'string' || typeof commit !== 'string'
    || !(CHANNEL_SHAPES as readonly string[]).includes(shape)
    || !(CHANNEL_COMMITS as readonly string[]).includes(commit)
  ) {
    return null;
  }
  return { from, to, shape: shape as ChannelShape, commit: commit as ChannelCommit };
}

/** 链模式键解码（非法键 = null）。 */
export function decode_chain_key(
  key: string,
): { a: string; mid: string; c: string; shape1: ChannelShape; commit1: ChannelCommit; shape2: ChannelShape; commit2: ChannelCommit } | null {
  let parts: unknown;
  try {
    parts = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts.length !== 8 || parts[0] !== 'chain') return null;
  const [, a, mid, c, shape1, commit1, shape2, commit2] = parts;
  if (
    typeof a !== 'string' || typeof mid !== 'string' || typeof c !== 'string'
    || typeof shape1 !== 'string' || typeof commit1 !== 'string'
    || typeof shape2 !== 'string' || typeof commit2 !== 'string'
    || !(CHANNEL_SHAPES as readonly string[]).includes(shape1)
    || !(CHANNEL_SHAPES as readonly string[]).includes(shape2)
    || !(CHANNEL_COMMITS as readonly string[]).includes(commit1)
    || !(CHANNEL_COMMITS as readonly string[]).includes(commit2)
  ) {
    return null;
  }
  return {
    a, mid, c,
    shape1: shape1 as ChannelShape, commit1: commit1 as ChannelCommit,
    shape2: shape2 as ChannelShape, commit2: commit2 as ChannelCommit,
  };
}

/** 从轨迹派生转场模式观察（每条 hop 一条；空 hops = 无观察）。 */
export function transitions_of_trail(trail: ExecutionTrail): OrgTransitionPattern[] {
  const out: OrgTransitionPattern[] = [];
  for (const hop of trail.hops) {
    out.push({
      from: hop.from,
      to: hop.to,
      shape: hop.shape,
      commit: hop_commit(hop),
      fan_width: hop_fan_width(hop),
    });
  }
  return out;
}

/** 从轨迹派生链模式观察（相邻 hop 对；连续性由轨迹校验保证）。 */
export function chains_of_trail(trail: ExecutionTrail): OrgChainPattern[] {
  const out: OrgChainPattern[] = [];
  const hops = trail.hops;
  for (let i = 0; i + 1 < hops.length; i++) {
    const h1 = hops[i]!;
    const h2 = hops[i + 1]!;
    out.push({
      a: h1.from,
      mid: h1.to,
      c: h2.to,
      shape1: h1.shape,
      commit1: hop_commit(h1),
      shape2: h2.shape,
      commit2: hop_commit(h2),
    });
  }
  return out;
}

/** 从轨迹派生作用域使用观察（去重保持首见顺序 + 收尾作用域）。 */
export function scope_usage_of_trail(trail: ExecutionTrail): TrailScopeUsage {
  const scopes: string[] = [];
  const seen = new Set<string>();
  const visit = (scope: string): void => {
    if (seen.has(scope)) return;
    seen.add(scope);
    scopes.push(scope);
  };
  visit(trail.entry_scope);
  for (const hop of trail.hops) visit(hop.to);
  const hops = trail.hops;
  const terminal = hops.length > 0 ? hops[hops.length - 1]!.to : trail.entry_scope;
  return { scopes, terminal };
}
