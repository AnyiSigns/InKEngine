/**
 * 绑定通道白名单（渲染器二层防线，与引擎侧同源语义）。
 *
 * 白名单构成（与引擎侧同源语义）：
 * - state.<字段>：回合状态通道——字段 = 会话快照声明键（messages / round_steps
 *   为主用法，session 为整快照通道）；bind.path 进一步细选；
 * - events.<type>：事件流通道，type 必须是事件类型注册表登记名（细粒度订阅）；
 * - inspect_graph / inspect_rules / inspect_knowledge / inspect_ui /
 *   inspect_tools / inspect_entities：六元快照。
 *
 * 内部通道纪律：「_」前缀通道禁绑（防信息泄漏）——顶层通道名与
 * 绑定路径的任何段都不允许以 _ 开头。
 */

import { EVENT_TYPE_NAMES } from '@/shared/session/eventTypes';
import { INSPECT_CHANNEL_NAMES } from '@/shared/session/inspectTypes';

/** state.* 家族：会话快照声明键 + 整快照通道 session。 */
export const STATE_SUB_CHANNELS = [
  'messages',
  'round_steps',
  'roundId',
  'streaming',
  'activeGear',
  'modeTier',
  'pendingReview',
  'reviewHistory',
  'simulations',
  'incubation',
  'sourceTraces',
  'patchChain',
  'eventMetrics',
  'session',
  // 任务级执行状态（task_state 子通道：plan/spawn/tool 家族归约面）
  'task_state',
] as const;

export function isStateChannel(channel: string): boolean {
  if (!channel.startsWith('state.')) return false;
  const sub = channel.slice('state.'.length);
  return (STATE_SUB_CHANNELS as readonly string[]).includes(sub);
}

export const EVENT_CHANNELS = EVENT_TYPE_NAMES.map((name) => `events.${name}` as const);

export const INSPECT_CHANNELS: readonly string[] = [...INSPECT_CHANNEL_NAMES];

/** 绑定路径（bind.path 点分段）逐段校验：_ 前缀段拒绝。 */
export function isPathAllowed(path: string): boolean {
  if (!path) return true;
  for (const segment of path.split('.')) {
    if (segment.startsWith('_')) return false;
  }
  return true;
}

/**
 * 绑定通道白名单判定：
 * - state.* / events.* / inspect_* 按细粒度条目判定；
 * - 顶层通道名不得以 _ 开头（内部通道禁绑）；
 * - 绑定路径任何 _ 前缀段拒绝。
 */
export function isBindChannelAllowed(channel: string, path = ''): boolean {
  if (channel.startsWith('_')) return false;
  const allowed = isStateChannel(channel)
    || EVENT_CHANNELS.includes(channel as (typeof EVENT_CHANNELS)[number])
    || INSPECT_CHANNELS.includes(channel);
  if (!allowed) return false;
  return isPathAllowed(path);
}

/** 白名单清单（inspect_ui 快照与设置页「关于」展示用）。 */
export function bindChannelWhitelist(): string[] {
  return [
    ...STATE_SUB_CHANNELS.map((sub) => `state.${sub}`),
    ...EVENT_CHANNELS,
    ...INSPECT_CHANNELS,
  ];
}
