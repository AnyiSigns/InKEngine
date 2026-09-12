/**
 * 路由规划（纯函数：路由决策 + 目录/通道目录状态 → 验证后的下一步执行计划）。
 *
 * 执行模型「作用域装载/通道执行」：`__next` 只是作用域的**意图声明**，实际转场
 * 是否成立须对照目录状态（目标作用域已注册？通道在册且未封？形态匹配？并行路数
 * 合法？）做**结构性校验**——本模块产出下一步的 RoutePlan（delegate/fan_out/
 * fan_in/return/converge/sink 六类）或显式拒绝原因（fail-closed：目录查不到 =
 * 拒，绝不臆造目标）。通道条件（资格/审批/并行上限/成本池）是运行时渗透语义，
 * 由 channel_gate 单独执行；本层只做目录与结构校验。
 *
 * 转场形态映射：
 * - delegate（1→1 子执行回传）：kind=scope（channel 缺省 delegate）或 channel
 *   shape=delegate；
 * - fan_out（1→N 并行子执行）：channel shape=fan_out（须声明 count）；
 * - fan_in（N→1 归并进目标作用域）：channel shape=fan_in；
 * - return（子执行归还父执行）：channel shape=return（父在场时才可执行）；
 * - converge / sink：收口计划（无通道/目标）。
 */

import { ChannelDirectory } from '../../model/channels/channel_directory.js';
import {
  CHANNEL_COMMIT_DEFAULT,
  CHANNEL_SHAPES,
  CHANNEL_SHAPE_DELEGATE,
  CHANNEL_SHAPE_FAN_IN,
  CHANNEL_SHAPE_FAN_OUT,
  CHANNEL_SHAPE_RETURN,
  type ChannelCommit,
  type ChannelShape,
} from '../../model/channels/channel_spec.js';
import { parse_temp_scope_def, type TempScopeDef } from './temp_scope.js';
import type { RoutingDecision } from './routing_next.js';

// ── 计划种类 ──

export const PLAN_DELEGATE = 'delegate';
export const PLAN_FAN_OUT = 'fan_out';
export const PLAN_FAN_IN = 'fan_in';
export const PLAN_RETURN = 'return';
export const PLAN_CONVERGE = 'converge';
export const PLAN_SINK = 'sink';

export const PLAN_KINDS = [
  PLAN_DELEGATE,
  PLAN_FAN_OUT,
  PLAN_FAN_IN,
  PLAN_RETURN,
  PLAN_CONVERGE,
  PLAN_SINK,
] as const;

export type RoutePlanKind = (typeof PLAN_KINDS)[number];

// ── 拒绝原因词表（测试与审计断言用；结构校验失败 = 显式拒绝）──

export const ROUTE_REJECT_CHANNEL_UNKNOWN = 'channel_unknown';
export const ROUTE_REJECT_CHANNEL_DISABLED = 'channel_disabled';
export const ROUTE_REJECT_CHANNEL_SHAPE_MISMATCH = 'channel_shape_mismatch';
export const ROUTE_REJECT_SCOPE_UNKNOWN = 'scope_unknown';
export const ROUTE_REJECT_SCOPE_AND_TEMP = 'scope_and_temp';
export const ROUTE_REJECT_NO_TARGET = 'no_target';
export const ROUTE_REJECT_FAN_OUT_COUNT_REQUIRED = 'fan_out_count_required';
export const ROUTE_REJECT_DELEGATE_COUNT_MUST_BE_ONE = 'delegate_count_must_be_one';
export const ROUTE_REJECT_COUNT_INVALID = 'count_invalid';
export const ROUTE_REJECT_TEMP_SCOPE_INVALID = 'temp_scope_invalid';
export const ROUTE_REJECT_RETURN_WITHOUT_PARENT = 'return_without_parent';

/** 校验通过的路由计划。 */
export interface RoutePlan {
  ok: true;
  kind: RoutePlanKind;
  /** 通道 id（converge/sink = ''）。 */
  channel_id: string;
  shape: ChannelShape | null;
  contract: ChannelCommit;
  /** 目标目录作用域 id（临时作用域计划 = null，目标定义随 temp_scope）。 */
  target_scope: string | null;
  temp_scope: TempScopeDef | null;
  /** 并行路数（fan_out = 声明数；其余 = 1）。 */
  count: number;
}

/** 路由拒绝（原因 = 词表之一）。 */
export interface RouteRejection {
  ok: false;
  reason: string;
  detail: string;
}

export type RouteResult = RoutePlan | RouteRejection;

function reject(reason: string, detail: string): RouteRejection {
  return { ok: false, reason, detail };
}

/** 通道结构性校验：在册 + 未封 + 形态匹配。 */
function resolve_channel(
  channels: ChannelDirectory,
  channel_id: string,
  expected: ChannelShape,
): RouteRejection | null {
  const spec = channels.get(channel_id);
  if (spec === null) {
    return reject(ROUTE_REJECT_CHANNEL_UNKNOWN, `通道未注册: ${channel_id}`);
  }
  if (spec.disabled) {
    return reject(ROUTE_REJECT_CHANNEL_DISABLED, `通道已封禁: ${channel_id}`);
  }
  if (spec.shape !== expected) {
    return reject(
      ROUTE_REJECT_CHANNEL_SHAPE_MISMATCH,
      `通道 ${channel_id} 形态 ${spec.shape} ≠ 期望 ${expected}`,
    );
  }
  return null;
}

function valid_count(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 1);
}

/** 目录作用域查询面（运行时注入：实体目录命中 + 非下架）。 */
export interface ScopeDirectoryView {
  has_scope(id: string): boolean;
}

/**
 * 路由规划：决策 → 计划或拒绝。
 *
 * @param decision 作用域声明的类型化路由决策。
 * @param opts.currentScope 当前作用域 id（入口路由局部判定的基准；converge/
 *   sink 之外主要供 return 父在场判定）。
 * @param opts.hasParent 当前执行是否子执行（return 计划须父在场）。
 * @param opts.directory 目录状态（作用域是否在册）。
 * @param opts.channels 通道目录。
 */
export function plan_routing(
  decision: RoutingDecision,
  opts: {
    currentScope: string;
    hasParent: boolean;
    directory: ScopeDirectoryView;
    channels: ChannelDirectory;
  },
): RouteResult {
  const { directory, channels } = opts;
  if (decision.kind === 'converge' || decision.kind === 'sink') {
    const plan: RoutePlan = {
      ok: true,
      kind: decision.kind === 'converge' ? PLAN_CONVERGE : PLAN_SINK,
      channel_id: '',
      shape: null,
      contract: CHANNEL_COMMIT_DEFAULT,
      target_scope: null,
      temp_scope: null,
      count: 1,
    };
    return plan;
  }
  if (!valid_count(decision.count)) {
    return reject(ROUTE_REJECT_COUNT_INVALID, `count 须为正整数（收到 ${String(decision.count)}）`);
  }
  // 目标来源二选一（parse 层已拦；planner 是公共纯函数面，独立调用时同样
  // fail-closed：目录引用与现场定义并存 = 语义未定，拒绝；显式 null 视同缺省）
  const tempRaw = decision.temp_scope === null ? undefined : decision.temp_scope;
  if (decision.target !== undefined && tempRaw !== undefined) {
    return reject(ROUTE_REJECT_SCOPE_AND_TEMP, '目录作用域与临时作用域二选一（不得同时声明）');
  }
  // 目标作用域解析（结构校验）
  if (tempRaw === undefined) {
    const target = decision.target;
    if (target === undefined) {
      return reject(ROUTE_REJECT_NO_TARGET, '路由决策未声明目标作用域');
    }
    if (!directory.has_scope(target)) {
      return reject(ROUTE_REJECT_SCOPE_UNKNOWN, `目录作用域未注册: ${target}`);
    }
  } else {
    try {
      parse_temp_scope_def(tempRaw);
    } catch (error) {
      return reject(ROUTE_REJECT_TEMP_SCOPE_INVALID, error instanceof Error ? error.message : String(error));
    }
  }
  const hasTemp = tempRaw !== undefined;
  const tempDef = hasTemp ? (tempRaw as TempScopeDef) : null;
  const targetId = hasTemp ? null : (decision.target as string);

  // 通道决议（kind=scope 缺省走 delegate；kind=channel 按名取）
  const channel_id =
    decision.kind === 'scope' ? (decision.channel ?? 'delegate') : (decision.channel as string);
  if (decision.kind === 'scope') {
    const bad = resolve_channel(channels, channel_id, CHANNEL_SHAPE_DELEGATE);
    if (bad !== null) return bad;
    const count = decision.count ?? 1;
    if (count !== 1) {
      return reject(ROUTE_REJECT_DELEGATE_COUNT_MUST_BE_ONE, `delegate 为 1→1（count=${count}）`);
    }
    const plan: RoutePlan = {
      ok: true,
      kind: PLAN_DELEGATE,
      channel_id,
      shape: CHANNEL_SHAPE_DELEGATE,
      contract: decision.contract ?? CHANNEL_COMMIT_DEFAULT,
      target_scope: targetId,
      temp_scope: tempDef,
      count: 1,
    };
    return plan;
  }
  // kind=channel：按通道形态决定计划
  const spec = channels.get(channel_id);
  if (spec === null) {
    return reject(ROUTE_REJECT_CHANNEL_UNKNOWN, `通道未注册: ${channel_id}`);
  }
  if (spec.disabled) {
    return reject(ROUTE_REJECT_CHANNEL_DISABLED, `通道已封禁: ${channel_id}`);
  }
  const shape = spec.shape as ChannelShape;
  const contract = decision.contract ?? spec.commit;
  if (shape === CHANNEL_SHAPE_DELEGATE) {
    const count = decision.count ?? 1;
    if (count !== 1) {
      return reject(ROUTE_REJECT_DELEGATE_COUNT_MUST_BE_ONE, `delegate 为 1→1（count=${count}）`);
    }
    const plan: RoutePlan = {
      ok: true,
      kind: PLAN_DELEGATE,
      channel_id,
      shape,
      contract,
      target_scope: targetId,
      temp_scope: tempDef,
      count: 1,
    };
    return plan;
  }
  if (shape === CHANNEL_SHAPE_FAN_OUT) {
    if (decision.count === undefined) {
      return reject(ROUTE_REJECT_FAN_OUT_COUNT_REQUIRED, 'fan_out 须声明并行路数 count');
    }
    const plan: RoutePlan = {
      ok: true,
      kind: PLAN_FAN_OUT,
      channel_id,
      shape,
      contract,
      target_scope: targetId,
      temp_scope: tempDef,
      count: decision.count,
    };
    return plan;
  }
  if (shape === CHANNEL_SHAPE_FAN_IN) {
    const plan: RoutePlan = {
      ok: true,
      kind: PLAN_FAN_IN,
      channel_id,
      shape,
      contract,
      target_scope: targetId,
      temp_scope: tempDef,
      count: 1,
    };
    return plan;
  }
  if (shape === CHANNEL_SHAPE_RETURN) {
    if (!opts.hasParent) {
      return reject(ROUTE_REJECT_RETURN_WITHOUT_PARENT, 'return 转场须在子执行内（父在场）');
    }
    const plan: RoutePlan = {
      ok: true,
      kind: PLAN_RETURN,
      channel_id,
      shape,
      contract,
      target_scope: targetId,
      temp_scope: tempDef,
      count: 1,
    };
    return plan;
  }
  return reject(
    ROUTE_REJECT_CHANNEL_SHAPE_MISMATCH,
    `通道形态非法: ${String(shape)}（须为 ${CHANNEL_SHAPES.join('/')}）`,
  );
}

/** 便捷：判定路由结果是否被拒（测试/上层断言语义化）。 */
export function route_ok(result: RouteResult): result is RoutePlan {
  return result.ok;
}

export function route_blocked(result: RouteResult): result is RouteRejection {
  return !result.ok;
}
