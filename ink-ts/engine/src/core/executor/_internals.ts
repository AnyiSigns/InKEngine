// gate: 超限(371 行) - 引擎内部件集中层（裁剪/队列/定位/互斥多机制同文件共享状态类型），拆分即扩散内部契约
/**
 * 执行引擎内部件（executor.py 移植——模块级机制/数据形态层）。
 *
 * 承载内部传输与协调器（_QueueTransport/_TransportSequencer）、计划步
 * 数据形态（_PlanAdvance/_PlanWorkOutcome）、节点协议（NodeContext）、并发
 * 原语（_Mutex/_AsyncQueue）、边/出口定位与恢复判据纯函数，以及确定性 seam
 * （id/时钟）。执行语义集中在 Engine（engine_* 分层）与 _NodeContextImpl。
 *
 * 保序协调器（_TransportSequencer）：落库 seq 来自存储（thread 事件日志
 * 全局计数器）——父引擎与并发实例交错推进同一 seq 空间、推送同一传输链。
 * 若各引擎独立维护 next_seq/pending，实例后续事件会因本引擎 seq 缺孔永远
 * 无法补齐（事件静默卡在各自缓冲）。共享同一协调器后，seq 连续即冲刷。
 */
import { EngineEvent, type EngineTransport } from '../events/events.js';
import { TerminateReason } from '../graph/graph_types.js';
import type { Graph } from '../graph/graph.js';
import { InterruptState } from '../interrupt/interrupt_types.js';
import type { Plan } from '../plan/plan.js';
import type { StateSchema } from '../state/schema.js';
import type { ResumeMap } from '../recovery/recovery_types.js';
import type { AssemblyResult } from '../assembly/assembly_types.js';

// ── 日志留痕 seam（Python logger → core 零 IO：缺省静默，可注入收集）────
let _warn_sink: ((message: string) => void) | null = null;
let _error_sink: ((message: string) => void) | null = null;

export function _set_log_sinks(warn: ((m: string) => void) | null, error: ((m: string) => void) | null): void {
  _warn_sink = warn;
  _error_sink = error;
}

/** warning 留痕（观察面副作用；注入后收集，缺省静默）。 */
export function _warn(message: string): void {
  if (_warn_sink !== null) _warn_sink(message);
}

/** error 留痕（观察面副作用；注入后收集，缺省静默）。 */
export function _error(message: string): void {
  if (_error_sink !== null) _error_sink(message);
}

// ── 确定性 seam（时间/默认 id）─────────────────────────────────────────
// core 零 IO 确定性：运行期时间只影响观测字段与日志降频；可注入时钟覆盖。
// 默认 id 由进程内单调计数生成（镜像 uuid4().hex[:12] 的形态但确定性）。
let _clock: (() => number) | null = null;
let _id_counter = 0;

/** 注入确定性时钟（epoch 秒）；null = 回落 Date.now()。 */
export function _set_clock(clock: (() => number) | null): void {
  _clock = clock;
}

/** 当前 epoch 秒（观测字段用；确定性 seam）。 */
export function _now_epoch(): number {
  return _clock !== null ? _clock() : Date.now() / 1000;
}

/** 当前毫秒级单调戳（事件日志错误降频用；确定性 seam）。 */
export function _now_monotonic_ms(): number {
  return _clock !== null ? _clock() * 1000 : Date.now();
}

/** 进程内确定性 id（前缀 + 单调十六进制；镜像 ``prefix-{uuid4.hex[:12]}``）。 */
export function _default_id(prefix: string): string {
  _id_counter += 1;
  return `${prefix}-${_id_counter.toString(16).padStart(12, '0')}`;
}

// ── input_assembly 事件体裁剪（事件降频）────────────────────────────────
// 激活留痕事件不携带全量源元数据：保留条数上限 + 标题长度上限——事件流体积
// 有界（可回放审计性不受影响：被裁条目语义 = 更多源，重建口径与全量一致）。
const _INPUT_ASSEMBLY_EVENT_MAX_SOURCES = 16;
const _INPUT_ASSEMBLY_EVENT_MAX_TITLE_CHARS = 120;

/** 激活记录 → 事件负载（体裁剪：源条数上限 + 标题截断）。 */
export function _input_assembly_event_record(record: { to_dict(): Record<string, unknown> }): Record<string, unknown> {
  const data = record.to_dict();
  const rawSources = data['sources'];
  const sources = Array.isArray(rawSources)
    ? rawSources.filter((s) => s !== null && typeof s === 'object' && !Array.isArray(s))
    : [];
  if (sources.length > _INPUT_ASSEMBLY_EVENT_MAX_SOURCES) {
    data['sources'] = sources.slice(0, _INPUT_ASSEMBLY_EVENT_MAX_SOURCES);
    data['sources_more'] = sources.length - _INPUT_ASSEMBLY_EVENT_MAX_SOURCES;
  }
  const kept = (data['sources'] as unknown[]) ?? [];
  for (const source of kept) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) continue;
    const recordObj = source as Record<string, unknown>;
    const title = recordObj['title'];
    if (typeof title === 'string' && title.length > _INPUT_ASSEMBLY_EVENT_MAX_TITLE_CHARS) {
      recordObj['title'] = `${title.slice(0, _INPUT_ASSEMBLY_EVENT_MAX_TITLE_CHARS)}…`;
    }
  }
  return data;
}

// ── 并发原语（asyncio.Lock / asyncio.Queue 的 TS 形态）───────────────────

/** 互斥锁（镜像 asyncio.Lock：串行化临界区，FIFO 唤醒）。 */
export class _Mutex {
  private _locked = false;
  private _waiters: Array<() => void> = [];

  /** 获取锁（已锁则排队；返回后临界区可进入）。 */
  acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  /** 释放锁（唤醒下一个等待者；无等待者 = 解锁）。 */
  release(): void {
    const next = this._waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this._locked = false;
  }

  /** ``async with`` 语义：执行 fn 期间持锁。 */
  async with_lock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** 无界异步队列（镜像 asyncio.Queue：get 等待 put）。 */
export class _AsyncQueue<T> {
  private readonly _items: T[] = [];
  private readonly _waiters: Array<(value: T) => void> = [];

  /** 队尾入队（无界：立即成功）。 */
  put(item: T): Promise<void> {
    const waiter = this._waiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return Promise.resolve();
    }
    this._items.push(item);
    return Promise.resolve();
  }

  /** 队首出队（空则等待）。 */
  get(): Promise<T> {
    const item = this._items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    return new Promise<T>((resolve) => {
      this._waiters.push(resolve);
    });
  }
}

// ── 内部传输：事件 → 异步队列（顶层 run 的流式产出通道）────────────────

export class _QueueTransport {
  private readonly _queue: _AsyncQueue<EngineEvent | null>;

  constructor(queue: _AsyncQueue<EngineEvent | null>) {
    this._queue = queue;
  }

  async send(event: EngineEvent): Promise<void> {
    await this._queue.put(event);
  }
}

/** 事件推送保序协调器（父引擎与 spawn 实例/嵌套子图共享）。 */
export class _TransportSequencer {
  readonly lock = new _Mutex();
  pending = new Map<number, EngineEvent>();
  next_seq: number | null = null;

  reset(): void {
    this.pending.clear();
    this.next_seq = null;
  }
}

// ── 计划步数据形态（引擎内部传递用，镜像 Python dataclass）─────────────

/**
 * 计划游标推进结果。node: 待执行节点（null = 无产出）；plan: 推进后计划
 * （null = 耗尽/终止）；state: 合并后状态；reason/error: 终止信号；
 * interrupt: 计划步内中断；parent_id/fork_write: 链写状态。
 */
export class _PlanAdvance {
  node: string | null = null;
  plan: Plan | null = null;
  state: Record<string, unknown> = {};
  reason: string | null = null;
  error: string | null = null;
  interrupt: InterruptState | null = null;
  parent_id: number | null = null;
  fork_write = false;

  constructor(init: Partial<_PlanAdvance> = {}) {
    Object.assign(this, init);
  }
}

/**
 * 计划工作步（并行组/spawn）执行结果与控制流信号。
 * overlay 与三种控制流信号互斥：有信号 = 本步未完成；无信号 = 本步完成。
 */
export class _PlanWorkOutcome {
  overlay: Record<string, unknown> = {};
  terminate: string | null = null;
  interrupt: InterruptState | null = null;
  error: string | null = null;

  constructor(init: Partial<_PlanWorkOutcome> = {}) {
    Object.assign(this, init);
  }
}

// ── 节点协议（执行器注入的节点上下文协议面）────────────────────────────

/**
 * 节点运行时上下文协议（graph.py NodeContext 的移植面）。节点函数经 ctx
 * 访问状态/发射事件/声明中断与终止；协议只钉住节点需要的读写面，执行器
 * 内部实现（_NodeContextImpl）扩展内部状态（spawn 收集清单/装配缓存等）。
 */
export interface NodeContext {
  readonly state: Record<string, unknown>;
  readonly graph_path: readonly string[];
  readonly thread_id: string;
  readonly round_id: string | null;
  readonly trace_id: string;
  /** 当前节点名（执行器在节点边界设置；并行成员经构造后赋值）。 */
  node: string | null;
  readonly terminated: boolean;
  readonly terminate_reason: string | null;
  /** 节点边界步数计数（预算策略可据此按步数终止）。 */
  step_count: number;

  emit(etype: string, payload: Record<string, unknown>, opts?: { step_id?: string | null }): Promise<void>;
  /** 声明中断点（无注入时抛 InterruptSignal；注入后返回注入值继续执行）。 */
  interrupt(review_key: string, payload: Record<string, unknown>): Promise<unknown>;
  /** 读取链尾挂起卡负载（重入场景；无存储/无命中返回 null）。 */
  get_interrupt_payload(review_key: string): Promise<Record<string, unknown> | null>;
  /** 命令式收集子图实例清单项（返回后由引擎统一展开）。 */
  spawn(subgraph: unknown, state: Record<string, unknown>, opts?: { index?: number | null }): void;
  /** 输入调配统一入口（节点内多源统一预算分配 → 组装）。 */
  assemble(
    sources: readonly unknown[],
    opts?: { total_budget?: number | null; version_snapshot?: Record<string, unknown> | null },
  ): Promise<AssemblyResult>;
  /** 节点执行前的统一预装配（执行器节点循环内自动调用）。 */
  preassemble(): Promise<void>;
  /** 结点执行边界 token 计账（LLM usage 帧 → 当前结点，纯算法）。 */
  account_usage(usage: Record<string, unknown> | null): void;
  /** 声明终止（校验延迟到执行器检查点）。 */
  terminate(reason: string, meta?: Record<string, unknown>): void;
  /** 嵌套子图恢复锚点表（graph_path → checkpoint_id）。 */
  resume_map?: ResumeMap;
}

// ── 状态合并辅助（schema reducer 合并 / 裸覆盖 的共用出口）───────────────

/** 状态增量合并（schema 就绪走 reducer；否则裸覆盖）。 */
export function _merge_overlay(
  schema: StateSchema | null,
  state: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(overlay).length === 0) return state;
  if (schema !== null) {
    return schema.apply(state, overlay);
  }
  return { ...state, ...overlay };
}

// ── 边 / 出口定位与恢复判据（镜像 executor.py 模块级函数）───────────────

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/**
 * 选择下一节点：静态边直接取；条件边逐条判定（首个为真生效）。
 * 条件边兼容同步/异步判定（thenable 检测）；判定失败按不满足处理
 * （fail-open 不阻断执行，留痕日志——core 零 IO 以静默省略）。
 */
export async function _select_next_node(graph: Graph, ctx: unknown, current: string): Promise<string | null> {
  const edges = graph.edges[current];
  if (edges === undefined || edges.length === 0) return null;
  for (const edge of edges) {
    if (edge.condition === null) return edge.target;
    try {
      const result = edge.condition(ctx);
      const outcome = isPromiseLike(result) ? await result : result;
      if (outcome) return edge.target;
    } catch (exc) {
      _warn(`条件边判定失败，按不满足处理 [${current}->${edge.target}]: ${String(exc)}`);
    }
  }
  return null;
}

/**
 * 边/出口定位：出口节点 → REPLY 终止；条件边/静态边 → 下一节点。
 *
 * @returns [reason, next]：reason 非 null = 终止（next 恒 null）；
 *   next 非 null = 继续执行该节点；两者皆 null = 图定义不完备（无出边且
 *   非 exit），按 stop 终止（入轨迹可诊断）。
 */
export async function _locate_next(
  graph: Graph,
  ctx: unknown,
  current: string,
): Promise<[string | null, string | null]> {
  if (graph.exits.has(current)) {
    return [TerminateReason.REPLY, null];
  }
  const nxt = await _select_next_node(graph, ctx, current);
  if (nxt === null) {
    if (!graph.exits.has(current)) {
      return [TerminateReason.STOP, null];
    }
    return [TerminateReason.REPLY, null];
  }
  return [null, nxt];
}

/**
 * 节点是否属于计划步骤的节点集合（恢复定位的兜底判据：旧存档无显式工作步
 * 标记时使用；新写 checkpoint 携带显式 work_step 标记，不再依赖猜测）。
 */
export function _node_in_plan_steps(node: string, plan: Plan): boolean {
  return plan.steps.some((step) => step.nodes.includes(node));
}

/** 计划快照是否带工作步标记（并行组/spawn 步内中断/失败的显式信号）。 */
export function _plan_snapshot_is_work_step(plan: Record<string, unknown> | null): boolean {
  return plan !== null && plan['work_step'] === true;
}

/** resume_map 键编码：graph_path 的 JSON 序列化（recovery 模块同口径）。 */
export function _resume_path_key(graph_path: readonly string[]): string {
  return JSON.stringify(graph_path);
}

/** 弹出嵌套子图恢复锚点（镜像 dict.pop(path, None)）。 */
export function _pop_resume_anchor(resume_map: ResumeMap | null | undefined, path: readonly string[]): number | null {
  if (resume_map === null || resume_map === undefined) return null;
  const key = _resume_path_key(path);
  const anchor = resume_map.get(key);
  if (anchor !== undefined) {
    resume_map.delete(key);
    return anchor;
  }
  return null;
}
