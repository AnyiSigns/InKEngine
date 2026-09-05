// gate: 超限(385 行) - 数据面核心：内联 marker 三类精确还原 + 值级脱敏接入，注释承载往返语义
/**
 * 存储数据形态：CheckpointRecord / ChainLink + 内联 marker 的 JSON 化
 * / 还原（_jsonable_strip / _from_jsonable）。storage.py 移植的纯数据
 * 面部分。
 *
 * CheckpointRecord 是版本链节点（重负载，state 含通道快照）；ChainLink
 * 是轻量行索引（仅回溯/巡检所需元数据，回溯逐跳重查询 → 一次取链）。
 *
 * 内联 marker（PATCH_CHAIN_MARKER / MESSAGE_MARKER / TOOL_CALL_MARKER）
 * 让 checkpoint JSON 列可承载非 JSON 形态（PatchChain / Message / ToolCall）
 * —— 写入侧打标、读取侧认标精确还原；不命中 marker 的子树按普通递归
 * （dict/list 容器/标量）处理。敏感信息剥离与序列化合并为单次遍历（热
 * 路径零拷贝：子树无敏感信息即返回原对象）；剥离为键级 + 值级合一——
 * 字符串叶子整体嵌入的 URL query token / 序列化 JSON 内嵌凭据属性同样
 * 遮蔽（ToolCall.arguments 等 JSON 串参数负载不原样落 checkpoint）。
 *
 * 字段口径：与 Python 字段一一对应；graph_path 防御拷贝为 readonly 数组
 * （元组不可变语义）；构造期不调 time.time/Date.now，由调用方经
 * options.now 注入（core 零时间依赖，ledger precedent）。
 */

import { InterruptState } from '../interrupt/interrupt_types.js';
import { Message, ToolCall } from '../llm/messages.js';
import { PatchChain } from '../patch/patchChain.js';
import { is_sensitive_key, strip_sensitive_text } from '../security/security.js';
import type { Json, JsonRecord } from '../json.js';

import {
  MESSAGE_MARKER,
  PATCH_CHAIN_MARKER,
  TOOL_CALL_MARKER,
} from './storage_constants.js';

function isPlainObject(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * state 深拷贝（marker 实例感知）：嵌套纯 JSON 容器逐层拷贝（快照持有期
 * 内外部改动隔离），PatchChain / Message / ToolCall 实例按原子保留同一
 * 引用——它们是经内联 marker 序列化的值对象，deepCopy 的 Object.entries
 * 拷贝会把实例摊平成普通 dict、毁掉 marker 还原语义（marker 序列化在
 * to_dict 的 jsonableStrip 阶段进行）。纯 JSON 子树走 core/json.ts deepCopy。
 */
function copyStateValue(value: unknown): unknown {
  if (value instanceof PatchChain || value instanceof Message || value instanceof ToolCall) {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = copyStateValue(value[i]);
    return out;
  }
  if (isPlainObject(value)) {
    const out: JsonRecord = {};
    for (const key of Object.keys(value)) {
      out[key] = copyStateValue(value[key]) as Json;
    }
    return out;
  }
  return value;
}

/**
 * 状态值 → JSON 可序列化形态（PatchChain/Message/ToolCall 内联为标记
 * dict，敏感键置空保留）。单次递归合并剥离与 JSON 化；copy-on-write：
 * 子树无敏感键且无内联 marker 即返回原对象（checkpoint 热路径零拷贝）。
 */
export function jsonableStrip(value: unknown): unknown {
  if (value instanceof PatchChain) {
    return {
      [PATCH_CHAIN_MARKER]: true,
      base: jsonableStrip(value.base),
      patches: value.patches.map((p) => ({
        op: p.op,
        path: [...p.path],
        value: jsonableStrip(p.value),
      })),
    };
  }
  if (value instanceof Message) {
    return { [MESSAGE_MARKER]: true, data: jsonableStrip(value.to_dict()) };
  }
  if (value instanceof ToolCall) {
    return {
      [TOOL_CALL_MARKER]: true,
      id: value.id,
      name: value.name,
      // 值级脱敏：arguments 是 JSON 串参数负载，可能内嵌 URL query token /
      // 序列化凭据属性——不原样落 checkpoint（键级剥离看不到字符串体内）
      arguments:
        value.arguments.length > 0 ? strip_sensitive_text(value.arguments) : value.arguments,
    };
  }
  if (isPlainObject(value)) {
    let changed = false;
    const out: JsonRecord = {};
    for (const key of Object.keys(value)) {
      if (is_sensitive_key(key)) {
        out[key] = '';
        changed = true;
        continue;
      }
      const stripped = jsonableStrip(value[key]);
      if (stripped !== value[key]) changed = true;
      out[key] = stripped as Json;
    }
    return changed ? out : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const stripped = jsonableStrip(value[i]);
      if (stripped !== value[i]) changed = true;
      out[i] = stripped;
    }
    return changed ? out : value;
  }
  if (typeof value === 'string') {
    // 值级脱敏：字符串叶子整体嵌入的 URL query token / JSON 文本内嵌
    // 凭据属性随单次遍历遮蔽（无命中原样返回，零拷贝语义不变）
    return value.length > 0 ? strip_sensitive_text(value) : value;
  }
  return value;
}

/** JSON 反序列化还原：标记 dict → PatchChain/Message/ToolCall，其余递归。 */
export function fromJsonable(value: unknown): unknown {
  if (isPlainObject(value)) {
    if (value[PATCH_CHAIN_MARKER] === true) {
      return PatchChain.from_dict(value as Parameters<typeof PatchChain.from_dict>[0]);
    }
    if (value[MESSAGE_MARKER] === true) {
      return Message.from_dict(fromJsonable(value['data']) as Record<string, Json>);
    }
    if (value[TOOL_CALL_MARKER] === true) {
      return new ToolCall({
        id: value['id'] as string,
        name: value['name'] as string,
        arguments: value['arguments'] as string,
      });
    }
    const out: JsonRecord = {};
    for (const k of Object.keys(value)) {
      out[k] = fromJsonable(value[k]) as Json;
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => fromJsonable(v));
  }
  return value;
}

/** Python 真值口径（镜像 dict.get(..., or 缺省) 的布尔取值）。 */
function isFalsy(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** 镜像 Python int()：数值截断/布尔 1/0/十进制整数字符串；非法 → RangeError。 */
function pyInt(value: unknown, name: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${name} 非有限数值: ${value}`);
    return Math.trunc(value);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) throw new RangeError(`${name} 非法整数: ${text}`);
    return Number(text);
  }
  if (typeof value === 'bigint') return Number(value);
  throw new RangeError(`${name} 类型不支持: ${typeof value}`);
}

/** 镜像 Python float()；非法 → RangeError。 */
function pyFloat(value: unknown, name: string, fallback: number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${name} 非有限数值: ${value}`);
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return fallback;
    const n = Number(text);
    if (!Number.isFinite(n)) throw new RangeError(`${name} 非法浮点: ${text}`);
    return n;
  }
  if (isFalsy(value)) return fallback;
  throw new RangeError(`${name} 类型不支持: ${typeof value}`);
}

/** CheckpointRecord 构造选项（now 等副作用参数注入面）。 */
export interface CheckpointRecordOptions {
  /** 创建时间戳（epoch 秒）；缺省 0（ledger precedent：core 零时间依赖）。 */
  now?: number;
}

/**
 * checkpoint 快照记录（版本链节点）。
 *
 * Attributes:
 *   checkpoint_id 全局自增 id（版本链锚点）。
 *   thread_id 会话/线程 id（版本链归属）。
 *   node 恢复锚点（该节点完成后写入的快照，重入从该节点继续）。
 *   graph_path 嵌套图路径（恢复定位）。
 *   state 通道值快照（api_key 已剥离）。
 *   parent_id 版本链父指针（null = 链头）。
 *   reason 回合终止原因（reply/止损/超限/异常，null = 未终止）。
 *   created_at 写入时间戳（epoch 秒）。
 *   version 乐观锁版本号（并发写保护，每次写入 +1）。
 *   event_seq 执行事件日志锚点（恢复 = 快照 + 该 seq 之后的增量重放）。
 *   error 异常快照（reason=error 时携带脱敏错误消息）。
 *   interrupt 挂起卡状态（reason=interrupted 时携带；其余 null）。
 *   graph_version 图定义内容指纹（恢复时与当前图比对，不一致拒绝续跑）。
 *   plan 运行中计划快照（{steps, index}，null = 无计划）。
 */
export class CheckpointRecord {
  readonly checkpoint_id: number;
  readonly thread_id: string;
  readonly node: string | null;
  readonly graph_path: readonly string[];
  readonly state: JsonRecord;
  readonly parent_id: number | null;
  readonly reason: string | null;
  readonly created_at: number;
  readonly version: number;
  readonly event_seq: number;
  readonly error: string | null;
  readonly interrupt: InterruptState | null;
  readonly graph_version: string | null;
  readonly plan: JsonRecord | null;

  constructor(init: {
    checkpoint_id: number;
    thread_id: string;
    node?: string | null;
    graph_path?: readonly string[];
    state?: JsonRecord;
    parent_id?: number | null;
    reason?: string | null;
    created_at?: number;
    version?: number;
    event_seq?: number;
    error?: string | null;
    interrupt?: InterruptState | null;
    graph_version?: string | null;
    plan?: JsonRecord | null;
    options?: CheckpointRecordOptions;
  }) {
    this.checkpoint_id = init.checkpoint_id;
    this.thread_id = init.thread_id;
    this.node = init.node ?? null;
    this.graph_path = [...(init.graph_path ?? [])];
    // 深拷贝 state：快照持有期内嵌套引用可被外部改动（浅拷贝只隔离顶层），
    // 深拷贝保证版本链节点互不干扰（marker 实例原子保留见 copyStateValue——
    // 内联 marker 序列化在 to_dict 阶段，state 拷贝不得摊平实例）
    this.state = init.state !== undefined && init.state !== null
      ? (copyStateValue(init.state) as JsonRecord)
      : {};
    this.parent_id = init.parent_id ?? null;
    this.reason = init.reason ?? null;
    const optNow = init.options?.now;
    this.created_at = init.created_at !== undefined ? init.created_at : (optNow !== undefined ? optNow : 0);
    this.version = init.version !== undefined ? init.version : 1;
    this.event_seq = init.event_seq !== undefined ? init.event_seq : 0;
    this.error = init.error ?? null;
    this.interrupt = init.interrupt ?? null;
    this.graph_version = init.graph_version ?? null;
    this.plan = init.plan !== undefined ? init.plan : null;
    Object.freeze(this);
  }

  /** 序列化为 JSON 形态（state 同步剥离敏感键 + 内联 marker）。 */
  to_dict(): JsonRecord {
    const interruptJson = this.interrupt !== null ? (jsonableStrip(this.interrupt.to_dict()) as JsonRecord) : null;
    return {
      checkpoint_id: this.checkpoint_id,
      thread_id: this.thread_id,
      node: this.node,
      graph_path: [...this.graph_path],
      state: jsonableStrip(this.state) as JsonRecord,
      parent_id: this.parent_id,
      reason: this.reason,
      created_at: this.created_at,
      version: this.version,
      event_seq: this.event_seq,
      error: this.error,
      interrupt: interruptJson,
      graph_version: this.graph_version,
      plan: this.plan,
    };
  }

  /**
   * 从 JSON 形态还原。``data.get(k) or 缺省`` 镜像 Python 布尔口径：
   * 0/空串/空列表都回落到缺省值，与 Python 行为完全对齐。
   */
  static from_dict(data: unknown, options: CheckpointRecordOptions = {}): CheckpointRecord {
    if (!isPlainObject(data)) {
      throw new TypeError('checkpoint 字典须为 dict');
    }
    const rawInterrupt = data['interrupt'];
    const interrupt =
      rawInterrupt !== undefined && rawInterrupt !== null && isPlainObject(rawInterrupt)
        ? InterruptState.from_dict(fromJsonable(rawInterrupt))
        : null;
    const rawGraphPath = data['graph_path'];
    let graph_path: string[];
    if (isFalsy(rawGraphPath)) {
      graph_path = [];
    } else if (Array.isArray(rawGraphPath)) {
      graph_path = rawGraphPath as string[];
    } else {
      throw new TypeError('graph_path 须为可迭代');
    }
    const rawState = data['state'];
    const state = isFalsy(rawState)
      ? {}
      : (fromJsonable(rawState) as JsonRecord);
    const planRaw = data['plan'];
    const plan = planRaw !== undefined && planRaw !== null && isPlainObject(planRaw) ? (planRaw as JsonRecord) : null;
    return new CheckpointRecord({
      checkpoint_id: pyInt(data['checkpoint_id'], 'checkpoint_id'),
      thread_id: data['thread_id'] as string,
      node: (data['node'] ?? null) as string | null,
      graph_path,
      state,
      parent_id: (data['parent_id'] ?? null) as number | null,
      reason: (data['reason'] ?? null) as string | null,
      created_at: pyFloat(data['created_at'], 'created_at', options.now ?? 0),
      version: isFalsy(data['version']) ? 1 : pyInt(data['version'], 'version'),
      event_seq: isFalsy(data['event_seq']) ? 0 : pyInt(data['event_seq'], 'event_seq'),
      error: (data['error'] ?? null) as string | null,
      interrupt,
      graph_version: (data['graph_version'] ?? null) as string | null,
      plan,
    });
  }
}

/**
 * 版本链轻量行索引（回溯/巡检/压缩用，不含 state 快照负载）。
 *
 * Attributes:
 *   checkpoint_id 全局自增 id。
 *   parent_id 版本链父指针（null = 链头）。
 *   event_seq 执行事件日志锚点。
 *   graph_path 嵌套图路径。
 *   reason 回合终止原因（null = 未终止）。
 */
export class ChainLink {
  readonly checkpoint_id: number;
  readonly parent_id: number | null;
  readonly event_seq: number;
  readonly graph_path: readonly string[];
  readonly reason: string | null;

  constructor(init: {
    checkpoint_id: number;
    parent_id: number | null;
    event_seq: number;
    graph_path?: readonly string[];
    reason?: string | null;
  }) {
    this.checkpoint_id = init.checkpoint_id;
    this.parent_id = init.parent_id;
    this.event_seq = init.event_seq;
    this.graph_path = [...(init.graph_path ?? [])];
    this.reason = init.reason ?? null;
    Object.freeze(this);
  }
}
