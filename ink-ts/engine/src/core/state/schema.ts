/**
 * 状态 schema（通道定义表 + 合并入口）与子图回流增量（嵌套子图/spawn 共用）。
 * 状态 = 通道字典；每个通道可挂 reducer；未挂 = 裸 LastValue（覆盖语义）。
 */

import { GraphDefinitionError } from '../errors.js';
import { deepEqual, isRecord, stableStringify } from '../json.js';
import { PatchChain } from '../patch/patchChain.js';
import { get_reducer, is_additive_reducer, type Reducer } from './reducers.js';

/** 状态通道定义：reducer 名（null = 裸 LastValue）。 */
export class Channel {
  constructor(readonly reducer: string | null) {}
}

export type ChannelSpec = Channel | string | null;

export function stateEquals(a: unknown, b: unknown): boolean {
  if (a instanceof PatchChain && b instanceof PatchChain) {
    return deepEqual(a.to_dict(), b.to_dict());
  }
  return deepEqual(a, b);
}

/** 条目身份键（additive 差集）：消息按 id；{kind,text} 按内容对；其余无稳定身份。 */
function itemKey(m: unknown): string | null {
  if (!isRecord(m)) return null;
  const mid = m['id'];
  if (mid !== undefined && mid !== null) return stableStringify(['id', mid]);
  if (m['text'] !== undefined && m['text'] !== null) {
    return stableStringify(['content', m['kind'] ?? null, m['text']]);
  }
  return null;
}

export class StateSchema {
  channels: Record<string, Channel>;

  constructor(channels?: Record<string, ChannelSpec> | null) {
    this.channels = {};
    for (const [name, spec] of Object.entries(channels ?? {})) {
      if (spec instanceof Channel) {
        this.channels[name] = spec;
      } else {
        get_reducer(spec); // fail-fast：构造期校验 reducer 名存在性
        this.channels[name] = new Channel(spec);
      }
    }
  }

  add(name: string, reducer: string | null = null): void {
    this.channels[name] = new Channel(reducer);
  }

  to_dict(): { channels: Record<string, string | null> } {
    const channels: Record<string, string | null> = {};
    for (const [name, channel] of Object.entries(this.channels)) channels[name] = channel.reducer;
    return { channels };
  }

  static from_dict(data: unknown): StateSchema | null {
    if (!data || !isRecord(data)) return null;
    const raw = data['channels'];
    if (raw !== undefined && raw !== null && !isRecord(raw)) {
      throw new GraphDefinitionError(
        `状态 schema channels 字段非法: 期望 dict，收到 ${typeof raw}`,
      );
    }
    const spec: Record<string, ChannelSpec> = {};
    for (const [name, reducer] of Object.entries(raw ?? {})) {
      if (reducer !== undefined && reducer !== null) {
        get_reducer(reducer as string); // 未注册 reducer 在此暴露（fail-fast）
        spec[name] = reducer as string;
      } else {
        spec[name] = null;
      }
    }
    return new StateSchema(spec);
  }

  /** 把节点增量 overlay 按通道 reducer 合并进 state（纯函数，返回新 dict）。 */
  apply(state: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
    if (Object.keys(overlay).length === 0) return { ...state };
    const result: Record<string, unknown> = { ...state };
    for (const [key, value] of Object.entries(overlay)) {
      const channel = this.channels[key];
      if (channel === undefined) {
        result[key] = value; // schema 外键：裸覆盖（宽容模式）
        continue;
      }
      const reducer: Reducer | null = get_reducer(channel.reducer);
      result[key] = reducer ? reducer(state[key], value) : value;
    }
    return result;
  }
}

/**
 * 子图回流增量：additive 通道按条目身份差集；其余入口已剥离归零后终态即新增
 * （减少回流噪音，防二次加和翻倍）。
 */
export function subgraph_overlay_delta(
  entryState: Record<string, unknown>,
  finalState: Record<string, unknown>,
  schema: StateSchema | null,
): Record<string, unknown> {
  if (schema === null) return { ...finalState };
  const delta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(finalState)) {
    const channel = schema.channels[key];
    const reducer = channel?.reducer ?? null;
    if (is_additive_reducer(reducer)) {
      if (value !== null && value !== undefined && !Array.isArray(value)) {
        throw new GraphDefinitionError(
          `additive 通道 '${key}' 的终态值非法：期望条目序列，收到 ${Array.isArray(value) ? 'list' : typeof value}`,
        );
      }
      const entryMsgs = entryState[key] === undefined ? [] : (entryState[key] as unknown[]);
      const entryKeys = new Set<string>();
      for (const m of entryMsgs) {
        const k = itemKey(m);
        if (k !== null) entryKeys.add(k);
      }
      const newMsgs = (value === null || value === undefined ? [] : (value as unknown[])).filter(
        (m) => !entryKeys.has(itemKey(m) ?? ''),
      );
      if (newMsgs.length > 0) delta[key] = newMsgs;
    } else if (!stateEquals(value, entryState[key])) {
      delta[key] = value;
    }
  }
  return delta;
}

/** spawn 实例回流增量（父结构键保护：声明结果通道才回流）。 */
export function subgraph_flowback_overlay(
  entryState: Record<string, unknown>,
  finalState: Record<string, unknown>,
  subSchema: StateSchema | null,
  parentSchema: StateSchema | null,
): Record<string, unknown> {
  if (subSchema === null) return { ...finalState };
  const delta = subgraph_overlay_delta(entryState, finalState, subSchema);
  if (Object.keys(delta).length === 0) return {};
  const overlay: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(delta)) {
    const channel = subSchema.channels[key];
    if (channel === undefined) continue; // 未声明通道 = 子图内部结构键，不回流
    if (is_additive_reducer(channel.reducer)) {
      const parentChannel = parentSchema?.channels[key];
      if (parentChannel === undefined || !is_additive_reducer(parentChannel.reducer)) {
        continue; // 父无 additive 承接：丢弃，防整链/增量替换父历史
      }
    }
    overlay[key] = value;
  }
  return overlay;
}
