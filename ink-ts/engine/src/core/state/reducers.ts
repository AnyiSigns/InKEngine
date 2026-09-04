/**
 * 状态通道 reducer 族（对齐补丁链心智模型）：
 * - 累积型 add_messages：每条消息 = 一个补丁（append/替换/删除语义）；
 * - 内容型 patch_chain：通道值 = PatchChain（基础 + 补丁链）；
 * - 合并型 merge_dicts / merge_metrics；
 * - 覆盖型 last_value（默认裸通道语义）。
 *
 * 常量字符串与 Python core/state.py 同源（镜像），注册表开放扩展。
 */

import { GraphDefinitionError } from '../errors.js';
import { deepCopy, deepEqual, isRecord, stableStringify, type Json, typeName } from '../json.js';
import { PatchChain } from '../patch/patchChain.js';
import type { Patch } from '../patch/types.js';

export type Reducer = (base: unknown, overlay: unknown) => unknown;

const REMOVE_MESSAGE_TYPE = 'RemoveMessage';

function messageId(msg: unknown): unknown {
  return isRecord(msg) && 'id' in msg ? (msg['id'] as unknown) : null;
}

function isRemoveMarker(msg: unknown): boolean {
  return isRecord(msg) && msg['type'] === REMOVE_MESSAGE_TYPE;
}

function messageContentKey(msg: unknown): string | null {
  if (!isRecord(msg)) return null;
  const role = msg['role'] ?? null;
  const content = msg['content'] ?? null;
  let key: string;
  try {
    key = stableStringify(content);
  } catch {
    key = String(content);
  }
  return stableStringify(['msg', role, key]);
}

/** 累积型归约：按 id 去重/替换，RemoveMessage 删除，无 id 按内容去重。 */
export function add_messages(base: unknown, overlay: unknown): unknown[] {
  const result: unknown[] = base === null || base === undefined ? [] : [...(base as unknown[])];
  const byId = new Map<unknown, number>();
  const seenNoId = new Set<string>();
  for (let i = 0; i < result.length; i++) {
    const mid = messageId(result[i]);
    if (mid !== null) byId.set(mid, i);
  }
  for (const msg of result) {
    if (messageId(msg) === null) {
      const key = messageContentKey(msg);
      if (key !== null) seenNoId.add(key);
    }
  }
  for (const msg of (overlay === null || overlay === undefined ? [] : (overlay as unknown[]))) {
    const mid = messageId(msg);
    if (mid === null) {
      const key = messageContentKey(msg);
      if (key !== null && seenNoId.has(key)) continue;
      result.push(msg);
      if (key !== null) seenNoId.add(key);
      continue;
    }
    if (isRemoveMarker(msg)) {
      const idx = byId.get(mid);
      if (idx !== undefined) {
        byId.delete(mid);
        result[idx] = null; // 标记删除，尾部统一移除防索引错位
      }
      continue;
    }
    const existing = byId.get(mid);
    if (existing !== undefined) {
      result[existing] = msg;
    } else {
      byId.set(mid, result.length);
      result.push(msg);
    }
  }
  return result.filter((m) => m !== null);
}

/** dict 浅合并（overlay 覆盖 base 同键）。 */
export function merge_dicts(base: unknown, overlay: unknown): unknown {
  const result: Record<string, unknown> = { ...(isRecord(base) ? base : {}) };
  if (isRecord(overlay)) Object.assign(result, overlay);
  return result;
}

/** 指标聚合：数值相加、嵌套 dict 递归合并、其余取 overlay；__reset__ 整体重置。 */
export function merge_metrics(base: unknown, overlay: unknown): unknown {
  const o = isRecord(overlay) ? overlay : {};
  if (o['__reset__'] === true) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (k !== '__reset__') out[k] = v;
    return out;
  }
  const b = isRecord(base) ? base : {};
  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(b), ...Object.keys(o)]);
  for (const key of keys) {
    const bv = b[key];
    const ov = o[key];
    if (isRecord(bv) && isRecord(ov)) {
      result[key] = merge_metrics(bv, ov);
    } else if (typeof bv === 'number' && typeof ov === 'number') {
      result[key] = bv + ov;
    } else if (key in o) {
      result[key] = ov;
    } else {
      result[key] = bv;
    }
  }
  return result;
}

function equalsPatch(a: Patch, b: Patch): boolean {
  if (a.op !== b.op) return false;
  if (a.path.length !== b.path.length) return false;
  for (let i = 0; i < a.path.length; i++) if (a.path[i] !== b.path[i]) return false;
  return deepEqual(a.value ?? null, b.value ?? null);
}

function patchesEqual(a: readonly Patch[], b: readonly Patch[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!equalsPatch(a[i]!, b[i]!)) return false;
  return true;
}

function isPatch(value: unknown): value is Patch {
  return isRecord(value) && typeof value['op'] === 'string' && Array.isArray(value['path']);
}

/** 内容型补丁链归约：反复应用 overlay = 追加补丁；同源回流只追加差集段。 */
export function patch_chain_reducer(base: unknown, overlay: unknown): PatchChain {
  if (overlay === null || overlay === undefined) {
    return base instanceof PatchChain ? base : new PatchChain();
  }
  let chain: PatchChain;
  if (base instanceof PatchChain) {
    chain = base;
  } else if (overlay instanceof PatchChain) {
    if (base !== null && base !== undefined && !isRecord(base)) {
      throw new GraphDefinitionError(
        `patch_chain 通道基底类型为 ${typeName(base)}，与 PatchChain overlay 合并会静默丢弃基底；请使用 PatchChain 或 dict 作为通道初值`,
      );
    }
    return overlay.branch();
  } else if (isPatch(overlay)) {
    chain = new PatchChain();
  } else if (isRecord(overlay)) {
    return new PatchChain(deepCopy(overlay as Json) as { [key: string]: Json });
  } else {
    chain = new PatchChain();
  }
  if (overlay === chain) return chain;
  if (overlay instanceof PatchChain) {
    const n = chain.length;
    if (overlay.length >= n && patchesEqual(chain.patches, overlay.patches.slice(0, n))) {
      chain.apply_many(overlay.patches.slice(n));
    } else {
      chain.apply_many(overlay.patches);
    }
  } else if (isPatch(overlay)) {
    const last = chain.patches[chain.patches.length - 1];
    if (last === undefined || !equalsPatch(last, overlay)) chain.apply(overlay);
  } else if (Array.isArray(overlay)) {
    const patches = overlay.filter(isPatch);
    const n = chain.length;
    if (patches.length >= n && patchesEqual(chain.patches, patches.slice(0, n))) {
      chain.apply_many(patches.slice(n));
    } else {
      chain.apply_many(patches);
    }
  }
  return chain;
}

/** 显式覆盖语义（裸 LastValue 的 reducer 表达）。 */
export function last_value(_base: unknown, overlay: unknown): unknown {
  return overlay;
}

export const REDUCER_REGISTRY: Record<string, Reducer> = {
  add_messages,
  merge_dicts,
  merge_metrics,
  patch_chain: patch_chain_reducer,
  last_value,
};

/** 累积追加族（additive）：子图回流按条目差集计算增量。 */
export const ADDITIVE_REDUCERS = new Set<string>(['add_messages']);

/** 合并累加族（merge）：父图合并恰好一次，防二次加和翻倍。 */
export const MERGE_REDUCERS = new Set<string>(['merge_metrics', 'merge_dicts']);

/** 注册自定义 reducer（幂等覆盖）；additive=true 声明为累积追加族。 */
export function register_reducer(name: string, reducer: Reducer, opts: { additive?: boolean } = {}): void {
  REDUCER_REGISTRY[name] = reducer;
  if (opts.additive === true) ADDITIVE_REDUCERS.add(name);
  else ADDITIVE_REDUCERS.delete(name);
}

export function is_additive_reducer(name: string | null | undefined): boolean {
  return name !== null && name !== undefined && ADDITIVE_REDUCERS.has(name);
}

export function is_merge_reducer(name: string | null | undefined): boolean {
  return name !== null && name !== undefined && MERGE_REDUCERS.has(name);
}

export function get_reducer(name: string | null | undefined): Reducer | null {
  if (name === null || name === undefined) return null;
  const reducer = REDUCER_REGISTRY[name];
  if (reducer === undefined) throw new GraphDefinitionError(`未知 reducer: ${name}`);
  return reducer;
}
