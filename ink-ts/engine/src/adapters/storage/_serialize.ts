/**
 * 序列化契约辅助（内存后端与 sqlite/postgres 同口径的 JSON 形态判定 +
 * 深拷贝还原）。
 *
 * checkpoint/records 走**严格** JSON 判定：不可 JSON 序列化的状态（任意
 * 类实例/函数/循环引用/NaN 等）抛错——与 Python json.dumps（无
 * default）失败行为对齐，杜绝「内存后端静默通过、切 sqlite 即错」的三
 * 后端漂移。事件负载走**宽松**判定：不可 JSON 序列化的叶值按
 * default=str 字符串化降级（与 Python json.dumps(..., default=str) 同
 * 口径），非 JSON 对象静默字符串化。
 *
 * 循环引用在两条路径都拒绝（镜像 Python 对 circular reference 的拒绝）；
 * 非有限数值（NaN/Infinity）拒绝（Python json.dumps 对该类值即使带
 * default 也抛 ValueError）。读取侧深拷贝经 from_dict/to_dict 往返还原，
 * 防消费方修改污染存储内快照。
 */

import { EngineEvent } from '../../core/events/events.js';
import { deepCopy, type Json, type JsonRecord } from '../../core/json.js';
import { StorageError } from '../../core/errors.js';
import { CheckpointRecord } from '../../core/storage/storage_records.js';

/** 统一异常消息提取（包装 StorageError 时保留底层原因文本）。 */
export function errMsg(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Python 真值外叶值字符串化（default=str 降级口径；字符串永不达此）。 */
function defaultStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

/**
 * 严格 JSON 判定（checkpoint 状态/records 写入前置）：值须为纯 JSON
 * 形态，否则抛错。只判定不改写——调用方随后经 from_dict/to_dict 深拷贝。
 */
export function assertStrictJson(value: unknown): void {
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null) return;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return;
    if (t === 'number') {
      if (!Number.isFinite(v)) throw new Error('数值非有限（NaN/Infinity）');
      return;
    }
    if (t !== 'object') throw new Error(`值不可 JSON 序列化（${t}）`);
    const obj = v as object;
    if (seen.has(obj)) throw new Error('循环引用不可 JSON 序列化');
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        for (const item of obj) walk(item);
        return;
      }
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('非 dict 对象不可 JSON 序列化');
      }
      for (const k of Object.keys(obj)) {
        walk((obj as Record<string, unknown>)[k]);
      }
    } finally {
      seen.delete(obj);
    }
  };
  walk(value);
}

/**
 * 宽松 JSON 往返（事件 payload）：不可序列化叶值按 default=str 字符串化，
 * 返回与 json.loads(json.dumps(v, default=str)) 同构的纯 JSON 值。
 */
export function toLenientJson(value: unknown): Json {
  const seen = new Set<object>();
  const conv = (v: unknown): Json => {
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('数值非有限（NaN/Infinity）');
      return v;
    }
    if (typeof v === 'bigint') return v.toString();
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
      return defaultStr(v);
    }
    const obj = v as object;
    if (seen.has(obj)) throw new Error('循环引用不可 JSON 序列化');
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        return obj.map((item) => conv(item));
      }
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        return defaultStr(v);
      }
      const out: JsonRecord = {};
      for (const k of Object.keys(obj)) {
        out[k] = conv((obj as Record<string, unknown>)[k]);
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };
  return conv(value);
}

/**
 * checkpoint 写入前规范化（与 SQL 后端同口径）：序列化契约 = to_dict
 * 严格 JSON 判定 + from_dict 精确还原。不可 JSON 序列化的状态抛
 * StorageError（含任意对象的状态在生产第一条 checkpoint 就失败，而非
 * 内存后端静默通过、切库即错）。
 */
export function normalizeCheckpointRecord(record: CheckpointRecord): CheckpointRecord {
  try {
    assertStrictJson(record.to_dict());
  } catch (exc) {
    throw new StorageError(`checkpoint 状态不可 JSON 序列化: ${errMsg(exc)}`);
  }
  return CheckpointRecord.from_dict(record.to_dict());
}

/** checkpoint 读取返回深拷贝副本（调用方修改返回记录不得污染存储内快照）。 */
export function copyCheckpointRecord(record: CheckpointRecord): CheckpointRecord {
  return CheckpointRecord.from_dict(record.to_dict());
}

/** 事件读取返回深拷贝副本（重放消费方修改事件不得污染存储内日志）。 */
export function copyEngineEvent(event: EngineEvent): EngineEvent {
  return new EngineEvent({
    type: event.type,
    version: event.version,
    payload: deepCopy(event.payload) as JsonRecord,
    step_id: event.step_id,
    parent_step_id: event.parent_step_id,
    round_id: event.round_id,
    node: event.node,
    graph_path: event.graph_path,
    seq: event.seq,
    trace_id: event.trace_id,
    thread_id: event.thread_id,
  });
}
