/**
 * `__next` 路由声明解析/校验（纯函数：产物载荷/模型文本 → 类型化 RoutingDecision）。
 *
 * 执行模型「自治调度 = 生成即路由」：作用域完成本职时在产物上声明下一步去哪个
 * 作用域 / 过哪条通道 / 收——路由决策并入产出，不另做判定调用。本模块把声明
 * 归一成**类型化决策**：
 *
 * - kind `scope`：进入目标作用域（1→1，channel 缺省 = delegate 委托通道）；
 * - kind `channel`：按名过一条通道（delegate/fan_out/fan_in/return 由通道形态
 *   决定转场语义；target/temp_scope 给目标，count 给并行路数）；
 * - kind `converge`：本轮收束——（子产物归并后）向汇聚点收敛；
 * - kind `sink`：直接结束回合给出最终答复（非工具/非通道）。
 *
 * 声明形态（两处均可，优先级 payload 内键 > 回复文本）：
 * - 产物 dict 的保留键 `__next`；
 * - 回复文本末尾的 fenced json 块 / `__next:` 行 / 纯 JSON 回复。
 * 取值/结构非法 = 显式抛错（fail-closed）；缺声明 = null（交由先验回落）。
 * 词汇约束：契约/形态取值一律复用 channel_spec 词表，不另立第二套枚举。
 */

import {
  CHANNEL_COMMITS,
  CHANNEL_COMMIT_FULL,
  type ChannelCommit,
} from '../../model/channels/channel_spec.js';
import { GraphDefinitionError } from '../../model/errors.js';
import { isRecord } from '../../model/json.js';
import type { TempScopeDef } from './temp_scope.js';

/** 产物保留键：路由声明（自治调度并入产出的 `__next` 键）。 */
export const PAYLOAD_NEXT_KEY = '__next';

/** 路由种类：scope = 进入目标作用域；channel = 按名过通道；converge = 收敛；
 *  sink = 直接结束回合给出最终答复。 */
export const NEXT_KINDS = ['scope', 'channel', 'converge', 'sink'] as const;

export type NextKind = (typeof NEXT_KINDS)[number];

/** 类型化路由决策（作用域产物声明的归一形态）。 */
export interface RoutingDecision {
  kind: NextKind;
  /** 目标目录作用域 id（scope/channel 且走目录资产时）。 */
  target?: string;
  /** 通道 id（kind=channel；kind=scope 时缺省 = delegate 委托通道）。 */
  channel?: string;
  /** 提交契约覆写（缺省 = 全量回传，与通道缺省契约同口径）。 */
  contract?: ChannelCommit | null;
  /** 并行路数（fan_out 声明；缺省 = 不声明）。 */
  count?: number;
  /** 目标临时作用域定义（现场定义优先于目录引用；与 target 二选一）。 */
  temp_scope?: TempScopeDef | null;
}

/** 校验辅助。 */
function _bad(where: string, expected: string): never {
  throw new GraphDefinitionError(`__next 路由声明 ${where} 非法: 期望 ${expected}`);
}

function _opt_string(raw: unknown, where: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') _bad(where, '非空字符串');
  return raw.trim();
}

function _valid_commit(value: string): value is ChannelCommit {
  return (CHANNEL_COMMITS as readonly string[]).includes(value);
}

/**
 * 解析/校验路由决策 dict（JSON 进 JSON 出；未知键忽略前向兼容）。
 * converge/sink 不得携带目标/通道/并行（收口声明无转场面）；scope 须有目标
 * （目录 id 或临时定义）；channel 须有通道 id + 目标。
 */
export function parse_routing_decision(raw: unknown): RoutingDecision {
  if (!isRecord(raw)) _bad('', 'dict');
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(NEXT_KINDS as readonly string[]).includes(kind)) {
    _bad('kind', `scope | channel | converge | sink（收到 ${String(kind)}）`);
  }
  const decision: RoutingDecision = { kind: kind as NextKind };
  const target = _opt_string(raw['target'], 'target');
  if (target !== undefined) decision.target = target;
  const channel = _opt_string(raw['channel'], 'channel');
  if (channel !== undefined) decision.channel = channel;
  const contract = raw['contract'];
  if (contract !== undefined && contract !== null) {
    if (typeof contract !== 'string' || !_valid_commit(contract)) {
      _bad('contract', `提交契约 ${CHANNEL_COMMITS.join('/')} 之一`);
    }
    if (contract !== CHANNEL_COMMIT_FULL) decision.contract = contract;
  }
  const count = raw['count'];
  if (count !== undefined) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      _bad('count', '正整数');
    }
    decision.count = count;
  }
  const temp = raw['temp_scope'];
  if (temp !== undefined && temp !== null) {
    decision.temp_scope = temp as unknown as TempScopeDef;
  }
  if (kind === 'converge' || kind === 'sink') {
    if (decision.target !== undefined || decision.channel !== undefined) {
      _bad('kind', `converge/sink 不得携带 target/channel（收口声明无转场面）`);
    }
    if (decision.temp_scope !== undefined) {
      _bad('kind', `converge/sink 不得携带 temp_scope`);
    }
    return decision;
  }
  if (kind === 'scope') {
    if (decision.target === undefined && decision.temp_scope === undefined) {
      _bad('target', `scope 声明须给目标作用域 id（或 temp_scope 现场定义）`);
    }
    if (decision.target !== undefined && decision.temp_scope !== undefined) {
      _bad('target', `target 与 temp_scope 二选一（目录资产 vs 现场定义）`);
    }
    return decision;
  }
  if (decision.channel === undefined) {
    _bad('channel', `channel 声明须给通道 id`);
  }
  if (decision.target === undefined && decision.temp_scope === undefined) {
    _bad('target', `channel 声明须给目标作用域 id（或 temp_scope）`);
  }
  if (decision.target !== undefined && decision.temp_scope !== undefined) {
    _bad('target', `target 与 temp_scope 二选一`);
  }
  return decision;
}

/** 从产物 dict 读 `__next`（保留键存在且为 dict → 解析；缺省 = null）。 */
export function parse_next_in_payload(payload: Record<string, unknown>): RoutingDecision | null {
  const raw = payload[PAYLOAD_NEXT_KEY];
  if (raw === undefined || raw === null) return null;
  return parse_routing_decision(raw);
}

/** 提取文本末尾的 JSON 对象（支持 fenced json 块 / 纯 JSON 回复）。 */
function _extract_json_object(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced !== null) {
    const cand = fenced[1]!;
    try {
      const parsed = JSON.parse(cand) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // 块不可解析 → 继续尝试其余形态
    }
  }
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // 全文非 JSON → 尝试行式声明
  }
  const line = text.split('\n').find((l) => l.trimStart().startsWith(`${PAYLOAD_NEXT_KEY}:`));
  if (line !== undefined) {
    const json = line.slice(line.indexOf(':') + 1).trim();
    try {
      const parsed = JSON.parse(json) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // 行式声明不可解析 → 返回 null（交由先验回落，不击穿回合）
    }
  }
  return null;
}

/** 从模型回复文本提取路由声明（`{"__next": {...}}` 包裹或直接决策 dict）。
 *  无声明/不可解析 = null（不抛错——路由声明是自治信号，缺省走先验回落）。 */
export function parse_next_in_text(reply: string): RoutingDecision | null {
  if (reply === '') return null;
  const obj = _extract_json_object(reply);
  if (obj === null) return null;
  const wrapped = obj[PAYLOAD_NEXT_KEY];
  try {
    if (wrapped !== undefined && wrapped !== null) {
      return parse_routing_decision(wrapped);
    }
    if (typeof obj['kind'] === 'string') {
      return parse_routing_decision(obj);
    }
  } catch {
    return null;
  }
  return null;
}

/** 回合产物 → 路由决策（payload 保留键优先；缺省回落文本解析；都无 = null）。 */
export function routing_decision_from_output(
  payload: Record<string, unknown>,
  reply: string,
): RoutingDecision | null {
  const fromPayload = parse_next_in_payload(payload);
  if (fromPayload !== null) return fromPayload;
  return parse_next_in_text(reply);
}
