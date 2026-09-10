/**
 * 通道条件执行（跨作用域转场的渗透条件：资格 / 审批 / 最大并行 / 成本池）。
 *
 * 执行模型「跨作用域必须过通道进入目标作用域入口；通道条件 = 资格/审批/最大
 * 并行/成本池」——转场是否成立不仅靠 route_planner 的目录结构校验，还须满足
 * 通道资产的运行时条件。本模块做**条件执行**：
 *
 * - eligibility：当前作用域须命中通道资格清单（空 = 不设资格墙）；
 * - approval：通道声明审批档 → 弹审批 seam（接受/自动 = 放行；其余 fail-closed
 *   阻断——审批姿态 auto/review/deny 语义由注入方沿用产品档位）；
 * - max_parallel：fan_out 声明路数 ≤ 通道上限；
 * - cost_pool_cap：本次转场关联成本池累计 + 预估增量 ≤ 通道成本池上限。
 *
 * 纯判定 + 注入 seam：资格/并行/成本池为纯函数判定；审批是异步 seam（宿主把
 * 既有审批核/姿态接线到此处，复用 approve 决议词汇：accept/auto 放行）。
 */

import { type ChannelSpec } from '../channels/channel_spec.js';

/** 条件执行结果（放行 / fail-closed 阻断 + 原因词）。 */
export interface ChannelGateVerdict {
  ok: boolean;
  reason: string;
  message: string;
}

function gate(ok: boolean, reason: string, message: string): ChannelGateVerdict {
  return { ok, reason, message };
}

/** 条件执行上下文（转场发生处的运行时事实）。 */
export interface ChannelGateContext {
  /** 当前作用域 id（资格判定主体）。 */
  currentScope: string;
  /** 已累计的成本池（该通道/执行关联成本）。 */
  accumulated_cost: number;
  /** 本次转场预估成本增量（fan_out = 子执行合计；缺省 0）。 */
  cost_increment?: number;
}

/** 审批请求（通道审批档 + 动作描述）。 */
export interface TransitionApprovalRequest {
  level: string;
  channel_id: string;
  action: Record<string, unknown>;
}

/** 审批 seam：接受/自动 = 放行；拒绝/其它 = 阻断（缺省 seam = 全拒，fail-closed）。 */
export type TransitionApprovalSeam = (
  request: TransitionApprovalRequest,
) => Promise<'accept' | 'auto' | 'reject'> | 'accept' | 'auto' | 'reject';

/** 缺省审批 seam：一律拒绝（未装配 = 审批要求即阻断，宁拒勿放）。 */
export function default_approval_seam(): TransitionApprovalSeam {
  return () => 'reject';
}

/** 资格判定：条件资格清单空 = 放行；非空须含当前作用域 id。 */
export function eligibility_allowed(spec: ChannelSpec, currentScope: string): ChannelGateVerdict {
  const list = spec.conditions.eligibility;
  if (list.length === 0) return gate(true, '', '');
  if (list.includes(currentScope)) return gate(true, '', '');
  return gate(
    false,
    'eligibility_denied',
    `通道 ${spec.id} 资格墙拒绝当前作用域 ${currentScope}（允许: ${list.join('/')}）`,
  );
}

/** 最大并行判定：声明路数 ≤ 通道上限（null = 不设）。 */
export function parallel_allowed(spec: ChannelSpec, count: number): ChannelGateVerdict {
  const cap = spec.conditions.max_parallel;
  if (cap === null) return gate(true, '', '');
  if (count <= cap) return gate(true, '', '');
  return gate(false, 'max_parallel_exceeded', `通道 ${spec.id} 并行上限 ${cap} < 声明路数 ${count}`);
}

/** 成本池判定：已累计 + 预估增量 ≤ 成本池上限（null = 不设）。 */
export function cost_pool_allowed(spec: ChannelSpec, ctx: ChannelGateContext): ChannelGateVerdict {
  const cap = spec.conditions.cost_pool_cap;
  if (cap === null) return gate(true, '', '');
  const increment = ctx.cost_increment ?? 0;
  if (ctx.accumulated_cost + increment <= cap) return gate(true, '', '');
  return gate(
    false,
    'cost_pool_exceeded',
    `通道 ${spec.id} 成本池上限 ${cap} < 累计 ${ctx.accumulated_cost} + 增量 ${increment}`,
  );
}

/** 审批档是否要求弹审批（null = 通道不额外设审批）。 */
export function approval_required(spec: ChannelSpec): string | null {
  return spec.conditions.approval;
}

/**
 * 通道条件全量执行（除审批为异步 seam 外全部纯判定）。
 *
 * @returns 阻断原因或 null（放行）。
 */
export async function enforce_transition_conditions(
  spec: ChannelSpec,
  ctx: ChannelGateContext,
  count: number,
  approval: TransitionApprovalSeam,
): Promise<ChannelGateVerdict | null> {
  const checks: ChannelGateVerdict[] = [
    eligibility_allowed(spec, ctx.currentScope),
    parallel_allowed(spec, count),
    cost_pool_allowed(spec, ctx),
  ];
  for (const check of checks) {
    if (!check.ok) return check;
  }
  const level = approval_required(spec);
  if (level === null) return null;
  const decision = await approval({
    level,
    channel_id: spec.id,
    action: { scope: ctx.currentScope, channel: spec.id, count },
  });
  if (decision === 'accept' || decision === 'auto') return null;
  return gate(
    false,
    'approval_denied',
    `通道 ${spec.id} 审批档 ${level} 未通过（决议 ${decision}，fail-closed 阻断转场）`,
  );
}
