/**
 * 执行器注入的节点上下文实现（executor.py ``_NodeContextImpl`` 移植）。
 *
 * 节点上下文把引擎的发射/中断/终止/输入调配能力接线到节点函数：
 * - emit/interrupt/terminate 挂载引擎 publish 与中断协调器（共享同一
 *   coordinator：子图/spawn 实例内的 interrupt 重入与父图同一通道）；
 * - spawn 命令式收集（ctx.spawn 追加清单，节点返回后统一展开）；
 * - assemble/preassemble 输入调配统一入口（预装配结果节点内复用，
 *   激活留痕只留一次）；
 * - account_usage 结点边界 token 计账（LLM usage 帧 → 当前结点成本账）。
 *
 * 内部形态（对齐 Python 私有面，供执行器在同模块族内读写）：
 * - ``_spawns`` 命令式 spawn 收集清单（节点边界复位、返回后统一展开）；
 * - ``_assembled`` 输入调配预装配结果缓存（preassemble 后节点内 assemble
 *   复用，不重复装配也不重复留痕）；
 * - ``_terminated`` 终止声明标记（节点边界复位，校验延迟到执行器检查点）；
 * - ``_transports`` 事件传输链（构造注入；缺省 = 引擎 options 默认）。
 */

import { SpawnSpec } from '../spawn/spawn.js';
import { InterruptSignal } from '../interrupt/interrupt_types.js';
import { interrupt_key_matches } from '../interrupt/interrupt.js';
import { EngineEvent, type EngineTransport } from '../events/events.js';
import { strip_sensitive } from '../security/security.js';
import { isRecord, type JsonRecord } from '../json.js';
import { GraphDefinitionError } from '../errors.js';
import { TraceStep, TRACE_SUCCESS } from '../settle/index.js';
import type { AssemblyResult } from '../assembly/assembly_types.js';
import type { ResumeMap } from '../recovery/recovery_types.js';
import type { EngineBase } from './_engine_base.js';
import type { NodeContext } from './_internals.js';
import { _input_assembly_event_record } from './_internals.js';

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/** 装配源提供者返回形态（源清单 或 (源清单, 版本快照) 二元组）。 */
type AssemblySourcesResult =
  | readonly unknown[]
  | [readonly unknown[], Record<string, unknown> | null]
  | Record<string, unknown>;

/**
 * 执行器注入的节点上下文（emit/interrupt/terminate 挂载引擎 publish）。
 * 状态/路径/回合等只读面按 Python 语义以 getter 承载；内部可变面以
 * ``_`` 前缀字段承载（供执行器在同执行族内读写）。
 */
export class _NodeContextImpl implements NodeContext {
  /** 当前结点名（节点边界由执行器设置；并行成员构造后赋值）。 */
  node: string | null;
  /** 输入调配预装配结果缓存（preassemble 后节点内 assemble 复用）。 */
  _assembled: AssemblyResult | null = null;
  /** 命令式 spawn 收集清单（节点内 ctx.spawn 追加，返回后统一展开）。 */
  _spawns: SpawnSpec[] = [];
  /** 终止声明标记（声明终止；校验延迟到执行器检查点）。 */
  _terminated: string | null = null;
  /** 事件传输链（构造注入；缺省 = 引擎 options 默认）。 */
  _transports: EngineTransport[];
  /** 嵌套子图恢复锚点表（graph_path → checkpoint_id）。 */
  resume_map: ResumeMap;
  /** 轨迹树父引用（推演分支/子任务事件指向决策点/父任务步骤）。 */
  parent_step_id: string | null;
  /** 节点边界步数计数（预算策略可按 ctx.step_count 按步数终止）。 */
  step_count = 0;

  readonly _engine: EngineBase;
  _state: Record<string, unknown>;
  readonly _graph_path: readonly string[];
  readonly _round_id: string | null;
  readonly _trace_id: string;
  readonly _thread_id: string;

  constructor(init: {
    engine: EngineBase;
    state: Record<string, unknown>;
    graph_path: readonly string[];
    round_id: string | null;
    trace_id: string;
    thread_id?: string;
    node?: string | null;
    transports?: EngineTransport[] | null;
    resume_map?: ResumeMap | null;
    parent_step_id?: string | null;
  }) {
    this._engine = init.engine;
    this._state = init.state;
    this._graph_path = init.graph_path;
    this._round_id = init.round_id;
    this._trace_id = init.trace_id;
    this._thread_id = init.thread_id ?? '-';
    this._transports = init.transports ?? this._engine.options.transports;
    this.node = init.node ?? null;
    this.resume_map = init.resume_map ?? new Map();
    this.parent_step_id = init.parent_step_id ?? null;
  }

  get state(): Record<string, unknown> {
    return this._state;
  }

  set state(state: Record<string, unknown>) {
    this._state = state;
  }

  get graph_path(): readonly string[] {
    return this._graph_path;
  }

  get thread_id(): string {
    return this._thread_id;
  }

  get round_id(): string | null {
    return this._round_id;
  }

  get trace_id(): string {
    return this._trace_id;
  }

  get terminated(): boolean {
    return this._terminated !== null;
  }

  get terminate_reason(): string | null {
    return this._terminated;
  }

  async emit(etype: string, payload: Record<string, unknown>, opts: { step_id?: string | null } = {}): Promise<void> {
    // 发射事件（事件即协议：负载直接对齐协议 v2，无框架中间层）。
    // 系统信号（宿主注入的 RunOptions.system_events 命中类型）不入回合
    // 步骤序列——强制 step_id=null，与事件协议语义对齐。
    let step_id = opts.step_id ?? null;
    if (this._engine.options.system_events.has(etype)) {
      step_id = null;
    }
    await this._engine._publish(
      new EngineEvent({
        type: etype,
        payload: payload as JsonRecord,
        step_id,
        parent_step_id: this.parent_step_id,
        round_id: this._round_id,
        node: this.node,
        graph_path: this._graph_path,
        trace_id: this._trace_id,
        thread_id: this._thread_id,
      }),
      { transports: this._transports },
    );
  }

  async interrupt(review_key: string, payload: Record<string, unknown>): Promise<unknown> {
    // 声明中断点：无注入值时挂起（InterruptSignal 被引擎捕获持久化）；
    // 外部注入后重入，本调用返回注入值，节点继续执行剩余逻辑。
    // gate 审批第二次起（同轮同工具再审批）发卡键掺入调用级唯一指纹
    // （``base#N``，见 InterruptCoordinator.next_gate_key）：注入按基底
    // 宽容消费（base 与 base#N 命中同一中断），确保新卡决议不命中旧中断。
    const decision = this._engine._coordinator.consume_review(review_key);
    if (decision !== null && decision !== undefined) {
      return decision;
    }
    throw new InterruptSignal(
      this._engine._coordinator.next_gate_key(this._thread_id, review_key),
      payload,
    );
  }

  async get_interrupt_payload(review_key: string): Promise<Record<string, unknown> | null> {
    // 读取链尾挂起卡负载（重入场景）：链尾中断 checkpoint 的 key 命中
    // 判定面键时返回卡负载（审批超时窗口等挂起时状态），否则 null。
    if (this._engine.options.storage === null) return null;
    const latest = await this._engine.options.storage.get_latest_checkpoint(this._thread_id);
    if (latest !== null && latest.interrupt !== null) {
      if (interrupt_key_matches(latest.interrupt.key, review_key)) {
        return latest.interrupt.payload;
      }
    }
    return null;
  }

  spawn(subgraph: unknown, state: Record<string, unknown>, opts: { index?: number | null } = {}): void {
    // 命令式子任务收集（便捷封装）：登记一个子图实例清单项。与数据驱动
    // 形态（节点返回值携带 ``__spawn__`` 键）等价——引擎在节点返回后
    // 统一展开收集的清单。index 缺省按收集顺序自动分配。
    this._spawns.push(
      new SpawnSpec({
        subgraph: subgraph as never,
        state: { ...state },
        index: opts.index !== null && opts.index !== undefined ? opts.index : this._spawns.length,
      }),
    );
  }

  async assemble(
    sources: readonly unknown[],
    opts: { total_budget?: number | null; version_snapshot?: Record<string, unknown> | null } = {},
  ): Promise<AssemblyResult> {
    // 输入调配统一入口（执行语义接线）：多源统一预算分配 → 组装。每次
    // LLM 调用/节点执行前经此统一调配，预算合计不超调用点总预算；激活
    // 记录随 input_assembly 事件落执行日志——模型可见皆留痕。预装配
    // （preassemble）已装配时直接复用缓存结果——不重复装配也不重复留痕。
    // 未启用（RunOptions.assembly=null）或关闭（enabled=False）时抛
    // GraphDefinitionError——调用点 catch 后回退旧装配路径。
    if (this._assembled !== null) return this._assembled;
    const assembler = this._engine._assembler;
    if (assembler === null) {
      throw new GraphDefinitionError('输入调配未启用（RunOptions.assembly=null），调用点应走旧装配路径');
    }
    const result = assembler.assemble(sources as never, {
      total_budget: opts.total_budget ?? null,
      version_snapshot: opts.version_snapshot ?? null,
    });
    this._assembled = result;
    await this.emit('input_assembly', {
      node: this.node,
      record: _input_assembly_event_record(result.record),
    });
    return result;
  }

  async preassemble(): Promise<void> {
    // 节点执行前的统一预装配（执行器节点循环内自动调用）。源由
    // RunOptions.assembly_sources 提供（返回源清单或 (源清单, 版本快照)
    // 二元组）；装配未启用/无源提供者时静默跳过（调用点回退旧路径）。
    // 装配结果缓存，节点内 assemble 复用。
    if (this._assembled !== null) return;
    const config = this._engine.options.assembly;
    const provider = this._engine.options.assembly_sources as
      | ((ctx: _NodeContextImpl) => AssemblySourcesResult | Promise<AssemblySourcesResult>)
      | null
      | undefined;
    if (config === null || !config.enabled || provider === null || provider === undefined) {
      return;
    }
    let supplied = provider(this);
    if (isPromiseLike(supplied)) {
      supplied = await supplied;
    }
    let sources: readonly unknown[];
    let version_snapshot: Record<string, unknown> | null = null;
    if (Array.isArray(supplied) && supplied.length === 2 && Array.isArray(supplied[0])) {
      const second = supplied[1];
      if (second === null || isRecord(second)) {
        sources = supplied[0] as readonly unknown[];
        version_snapshot = isRecord(second) ? (second as Record<string, unknown>) : null;
      } else {
        sources = supplied as unknown as readonly unknown[];
      }
    } else {
      sources = supplied as unknown as readonly unknown[];
    }
    if (sources.length === 0) {
      // 无源可激活 = 无事可调：跳过装配与留痕（空激活记录是噪音）
      return;
    }
    await this.assemble(sources, { version_snapshot });
  }

  terminate(reason: string, _meta: Record<string, unknown> = {}): void {
    // 声明终止（校验延迟到执行器检查点：编程错误不被节点异常捕获吞掉）。
    this._terminated = reason;
  }

  account_usage(usage: Record<string, unknown> | null): void {
    // 结点执行边界 token 计账（LLM usage 帧 → 当前结点，纯算法）。
    // usage 帧形态与 LLMChunk.usage 对齐（total_tokens 或 prompt_tokens +
    // completion_tokens）；记入本 run 的成本账，随沉淀钩子按边归集
    // avg_cost。未调用 = 无成本记录，零影响。
    if (usage === null || usage === undefined || !isRecord(usage)) return;
    let tokens: unknown = usage['total_tokens'];
    if (tokens === null || tokens === undefined) {
      const prompt = usage['prompt_tokens'];
      const completion = usage['completion_tokens'];
      tokens = Number(prompt ?? 0) + Number(completion ?? 0);
    }
    let parsed: number;
    try {
      parsed = typeof tokens === 'boolean' ? (tokens ? 1 : 0) : Math.trunc(Number(tokens));
    } catch {
      return;
    }
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return;
    if (parsed <= 0) return;
    if (this.node === null) return;
    this._engine._trace_add_tokens(this._graph_path, this.node, parsed);
  }
}

// 轨迹步骤形态（settle TraceStep 复用；本文件不复用 Engine，仅类型）
export type { TraceStep };

/** 并行组成员直入轨迹用的成员标记状态（与主循环同三态）。 */
export const _MEMBER_TRACE_SUCCESS = TRACE_SUCCESS;
