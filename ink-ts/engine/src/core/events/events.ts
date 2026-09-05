/**
 * 事件协议：EngineEvent 信封 + 协议版本化 + 传输接口（events.py 移植）。
 *
 * 事件即协议：节点经 ctx.emit 发射的事件流 = 前端协议的引擎原生形态
 * （step_id/round_id 天然有序，无框架事件中间层）。事件携带 step_id/
 * round_id/graph_path（嵌套图路径），负载为与协议同构的 dict
 * （thinking/plan/tool/node/reply_token/review_card...）。
 *
 * 协议演进策略：版本化结构（PROTOCOL_VERSION 常量）+ payload 增量演进
 * （加字段不破坏，step_id/round_id 语义长期稳定）；破坏性变更升版本，
 * 不兼容版本在传输入口拒绝（ProtocolVersionError）。
 *
 * 传输接口化：EngineTransport = 事件消费者（SSE/WS/队列可换实现），引擎只
 * 负责产出事件流，消费方式由宿主注入（引擎提供内存传输/收集器）。
 *
 * ProtocolVersionError 暂居本模块——收敛至 errors.ts（EngineError 继承面）
 * 待办。Python 侧的 warning 留痕属可观测性副作用，
 * TS core 零 IO 不落；容错语义（跳过返回 null/字符串化降级）原样保留。
 */

import { isRecord, type JsonRecord } from '../json.js';

/** 事件协议版本：与前端协议同构（前端零改动约束）。 */
export const PROTOCOL_VERSION = 2;

/** 事件协议版本不兼容（增量演进范围内加字段兼容，破坏性变更需升级版本）。 */
export class ProtocolVersionError extends Error {
  constructor(found: unknown, expected: number) {
    super(`事件协议版本不兼容: found=${found}, expected=${expected}`);
    this.name = 'ProtocolVersionError';
  }
}

/** EngineEvent 构造参数（镜像 Python 关键字构造；字段与 dataclass 一一对应）。 */
export interface EngineEventInit {
  type: string;
  payload?: JsonRecord;
  step_id?: string | null;
  parent_step_id?: string | null;
  round_id?: string | null;
  node?: string | null;
  graph_path?: readonly string[];
  seq?: number | null;
  trace_id?: string;
  thread_id?: string;
  version?: number;
}

/** Python 真值口径（镜像 dict.get(..., or 缺省) 的布尔取值）。 */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** 镜像 Python int()：数值截断、布尔 1/0、十进制整数字符串；非法形态抛错。 */
function pyInt(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('int() 参数非有限数值');
    return Math.trunc(value);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) throw new Error(`int() 参数非法: ${text}`);
    return Number(text);
  }
  if (typeof value === 'bigint') return Number(value);
  throw new Error('int() 参数类型不支持');
}

/** 对象原型判别：仅普通 dict 形态参与 JSON 递归（类实例等按降级路径处理）。 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Python str() 口径渲染（default=str 降级用）：None 兜底、布尔大写。 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

/**
 * 对齐 json.dumps(ensure_ascii=False) 的序列化（保留键插入序与分隔空格）。
 *
 * fallback=false：遇到不可 JSON 序列化值抛错（镜像 json.dumps 的
 * TypeError/ValueError）；fallback=true：该类叶值按 default=str 字符串化
 * 降级（回放类型降级）。循环引用在两条路径下都抛错（镜像 Python 对
 * circular reference 的拒绝），交由调用方走最小契约兜底。
 */
function pythonDumps(value: unknown, active: Set<object>, fallback: boolean): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') return String(value);
  if (value === undefined || t === 'function' || t === 'symbol' || t === 'bigint') {
    if (!fallback) throw new Error('值不可 JSON 序列化');
    return JSON.stringify(pyStr(value));
  }
  const obj = value as object;
  if (active.has(obj)) throw new Error('循环引用不可 JSON 序列化');
  if (Array.isArray(value)) {
    active.add(value);
    try {
      return `[${value.map((item) => pythonDumps(item, active, fallback)).join(', ')}]`;
    } finally {
      active.delete(value);
    }
  }
  if (isPlainObject(value)) {
    active.add(value);
    try {
      const record = value as Record<string, unknown>;
      const parts = Object.keys(record).map(
        (key) => `${JSON.stringify(key)}: ${pythonDumps(record[key], active, fallback)}`,
      );
      return `{${parts.join(', ')}}`;
    } finally {
      active.delete(value);
    }
  }
  if (!fallback) throw new Error('对象不可 JSON 序列化');
  return JSON.stringify(pyStr(value));
}

/**
 * 引擎事件信封（协议原生形态，只读）。
 *
 * 字段语义：
 * - type: 事件类型（thinking_start/reply_token/review_card/...）；
 * - payload: 事件负载（与协议同构 dict，增量演进加字段）；
 * - step_id: 回合步骤 id（展示事件契约；系统信号为 null）；
 * - parent_step_id: 父步骤 id（轨迹树引用：模拟分支/子任务事件指向决策
 *   点/父任务步骤，落选分支可据此回溯对比/换选）；
 * - round_id: 回合 id（用户消息边界）；
 * - node: 发射节点名（null = 执行器自身信号）；
 * - graph_path: 嵌套图路径（空 = 顶层图）；
 * - seq: 执行事件日志序号（append-only，恢复/续流锚点）；
 * - trace_id: 链路追踪 ID（跨事件传递）；
 * - thread_id: 会话/线程归属（执行日志分区键）；
 * - version: 协议版本。
 */
export class EngineEvent {
  readonly type: string;
  readonly payload: JsonRecord;
  readonly step_id: string | null;
  readonly parent_step_id: string | null;
  readonly round_id: string | null;
  readonly node: string | null;
  readonly graph_path: readonly string[];
  readonly seq: number | null;
  readonly trace_id: string;
  readonly thread_id: string;
  readonly version: number;

  constructor(init: EngineEventInit) {
    this.type = init.type;
    this.payload = init.payload ?? {};
    this.step_id = init.step_id ?? null;
    this.parent_step_id = init.parent_step_id ?? null;
    this.round_id = init.round_id ?? null;
    this.node = init.node ?? null;
    this.graph_path = [...(init.graph_path ?? [])];
    this.seq = init.seq ?? null;
    this.trace_id = init.trace_id ?? '-';
    this.thread_id = init.thread_id ?? '-';
    this.version = init.version ?? PROTOCOL_VERSION;
  }

  /** 序列化为协议结构（payload 增量演进，加字段兼容旧消费者）。 */
  to_dict(): JsonRecord {
    return {
      type: this.type,
      version: this.version,
      payload: this.payload,
      step_id: this.step_id,
      parent_step_id: this.parent_step_id,
      round_id: this.round_id,
      node: this.node,
      graph_path: [...this.graph_path],
      seq: this.seq,
      trace_id: this.trace_id,
      thread_id: this.thread_id,
    };
  }

  /** 反序列化（执行日志回放/断线续流恢复）；版本不符抛 ProtocolVersionError。 */
  static from_dict(data: JsonRecord): EngineEvent {
    if (!('type' in data)) {
      throw new Error('事件字典缺 type 字段');
    }
    const rawVersion: unknown = 'version' in data ? data['version'] : PROTOCOL_VERSION;
    const version = pyInt(rawVersion);
    if (version !== PROTOCOL_VERSION) {
      throw new ProtocolVersionError(rawVersion, PROTOCOL_VERSION);
    }
    const payloadRaw: unknown = data['payload'];
    const graphPathRaw: unknown = data['graph_path'];
    let graph_path: readonly string[];
    if (!isTruthy(graphPathRaw)) {
      graph_path = [];
    } else if (Array.isArray(graphPathRaw)) {
      graph_path = graphPathRaw as string[];
    } else if (typeof graphPathRaw === 'string') {
      graph_path = Array.from(graphPathRaw);
    } else {
      throw new Error('graph_path 需可迭代');
    }
    return new EngineEvent({
      type: data['type'] as string,
      payload: isTruthy(payloadRaw) ? (payloadRaw as JsonRecord) : {},
      step_id: (data['step_id'] ?? null) as string | null,
      parent_step_id: (data['parent_step_id'] ?? null) as string | null,
      round_id: (data['round_id'] ?? null) as string | null,
      node: (data['node'] ?? null) as string | null,
      graph_path,
      seq: (data['seq'] ?? null) as number | null,
      trace_id: ((data['trace_id'] ?? null) as string | null) ?? '-',
      thread_id: ((data['thread_id'] ?? null) as string | null) ?? '-',
      version,
    });
  }

  /**
   * JSON 序列化（事件传输线格式，非 ASCII 中文原样可读）。
   *
   * 负载须为 JSON 可序列化形态；含非 JSON 对象时按 default=str 字符串化
   * 降级（回放类型降级，Python 侧记 warning 留痕，此处零 IO 不落）。二次
   * 序列化仍失败（极端形态）时落最小契约（type/node/error），保证事件
   * 传输线不击穿主流程。
   */
  to_json(): string {
    const target = this.to_dict();
    try {
      return pythonDumps(target, new Set<object>(), false);
    } catch {
      try {
        return pythonDumps(target, new Set<object>(), true);
      } catch {
        const minimal: Record<string, unknown> = {
          type: this.type,
          node: this.node,
          error: 'serialization failed',
        };
        return pythonDumps(minimal, new Set<object>(), false);
      }
    }
  }
}

/**
 * 逐条事件解析（回放容错入口）：单条非法事件跳过，不中断整段重放。
 *
 * 旧版本协议事件/单条结构损坏的事件不应让整个恢复区间失败——逐条
 * try/except，跳过并留痕，其余事件照常回放（TS 侧零 IO，留痕不落，
 * 语义仅保留解析结果）。返回 null = 调用方跳过。
 */
export function parse_event_lenient(data: unknown): EngineEvent | null {
  if (!isRecord(data)) return null;
  try {
    return EngineEvent.from_dict(data);
  } catch {
    return null;
  }
}

/** 事件传输接口：消费引擎产出的事件（SSE/WS/队列可换实现）。 */
export interface EngineTransport {
  send(event: EngineEvent): Promise<void>;
}

/** 内存收集传输：累积全部事件（测试/调试/回放用），send 永不失败。 */
export class CollectorTransport implements EngineTransport {
  events: EngineEvent[] = [];

  async send(event: EngineEvent): Promise<void> {
    this.events.push(event);
  }
}
