/**
 * 引擎基座（executor.py ``Engine`` 移植——字段/装配面）。
 *
 * 引擎实例：Graph + 配置的组装点（业务侧一次构建，多次 run）。
 *
 * 并发模型：checkpoint 并发写保护在存储层（链尾乐观锁，冲突拒绝/重读），
 * 同实例并发 run 由存储层与业务层串行化保障。
 *
 * 本文件是执行器分层链的根：构造与全部实例字段落此；事件发布/恢复/轨迹/
 * 入口/实例工厂/checkpoint/展开/计划/多径/主循环等方法沿分层链逐文件实现
 * （见 _engine_events.ts 起）。分层依据 = Python 类内机制边界，成员公开
 * 且带 ``_`` 前缀（Python 下划线私有约定在 TS 不做硬封装——测试与嵌套
 * 引擎需要同族访问，与 Python 语义一致）。
 *
 * 确定性 seam：checkpoint/事件的时间戳与默认 thread/trace id 经
 * ``_internals`` 的时钟/id 注入面提供（core 零 IO 确定性），构造零副作用。
 */
import { Graph, type CompiledGraph } from '../graph/graph.js';
import { RunOptions } from '../run_result/run_result.js';
import { InterruptCoordinator } from '../interrupt/interrupt.js';
import { InputAssembler } from '../assembly/input_assembler.js';
import { GraphDefinitionError } from '../errors.js';
import { EngineEvent, type EngineTransport } from '../events/events.js';
import { TraceStep, TRACE_SUCCESS, TRACE_FAILED, TRACE_SKIPPED } from '../settle/index.js';
import type { Graph as GraphType } from '../graph/graph.js';

import { run_subgraph } from './run_subgraph.js';
import type { _AsyncQueue, NodeContext } from './_internals.js';
import { _TransportSequencer, _Mutex } from './_internals.js';

/** ``_execute`` 主执行循环选项（镜像 Python 关键字参）。 */
export interface ExecuteOptions {
  state: Record<string, unknown>;
  thread_id: string;
  round_id: string | null;
  resume_from: number | null;
  trace_id: string;
  queue: _AsyncQueue<EngineEvent | null> | null;
  parent_checkpoint?: number | null;
  continue_chain?: boolean;
  graph_path?: readonly string[];
  transports?: EngineTransport[] | null;
  resume_map?: Map<string, number> | null;
  checkpoint_thread_id?: string | null;
  parent_step_id?: string | null;
}

/**
 * 引擎实例（抽象基座：字段/装配 + 抽象执行面）。
 *
 * 字段逐一镜像 Python ``Engine.__init__``；抽象方法为分层链中被下方
 * 消费、由更上层实现的方法（当前仅 ``_execute``/``_publish``/
 * ``_trace_add_tokens``——节点上下文与入口/展开层据此静态可见）。
 */
export abstract class EngineBase {
  /** 图定义（业务侧注入，编译/指纹在构造期完成）。 */
  graph: Graph;
  /** 执行选项（存储/传输/预算/schema/计划/推演/调配注入面）。 */
  options: RunOptions;
  /** 编译校验产物（构造期 graph.compile()）。 */
  compiled: CompiledGraph;
  /** 中断协调器（注入值挂载/重入判定/gate 发卡计数）。 */
  _coordinator: InterruptCoordinator;
  /** 事件计数（每 run 归零；events_emitted 统计来源）。 */
  _event_counter: number;
  /** 事件登记锁：并行节点组（计划步骤）成员并发发射时串行化计数与
   *  seq 锚点登记（防丢更新/乱序覆盖导致恢复重放重复事件）。 */
  _event_lock: _Mutex;
  /** 传输推送保序协调器（父引擎与 spawn 实例/嵌套子图共享，见 _internals）。 */
  _transport_seq: _TransportSequencer;
  /** 图内容指纹（checkpoint 图版本）：恢复时与锚点比对（图定义变了 =
   *  恢复语义不保证，拒绝续跑）。 */
  _graph_digest: string;
  /** 子图引擎缓存（嵌套图/循环/并行场景避免每次执行重复 compile）——
   *  缓存键 = 图内容 digest（ENG2-6）：同定义子图跨实例复用。 */
  _subgraph_engines: Map<string, EngineBase>;
  /** 执行回路护栏（ENG2-5）：单节点访问次数（每轮 _execute 复位）。 */
  _node_visits: Record<string, number>;
  /** 事件日志写失败降频时间戳（存储故障时避免每事件一条 ERROR 洪水）。 */
  _event_log_error_ts: number;
  /** 内存态执行日志 seq（checkpoint 锚点权威来源；None = 尚无事件）。 */
  _latest_event_seq: number | null;
  /** 链尾推进标志：嵌套子图/spawn 实例执行后置位（下次写 checkpoint 前
   *  据此查询链尾作为 parent）。 */
  _chain_advanced: boolean;
  /** 已执行节点步数（本引擎累计；子链步数截止护栏的判据）。 */
  executed_node_steps: number;
  /** 输入调配管线执行体（RunOptions.assembly 非 null 时启用）。 */
  _assembler: InputAssembler | null;
  /** 结点级成败留痕（沉淀钩子输入）：本 run 的执行轨迹与成本账。 */
  _run_trace: TraceStep[];
  /** 结点 token 账（(graph_path, node) 编码键 → tokens）。 */
  _node_tokens: Map<string, number>;
  /** 轨迹图映射（graph_path 编码键 → Graph；沉淀回放同源）。 */
  _trace_graphs: Map<string, GraphType>;
  /** 待收尾的当前结点步骤（成败在收尾前经标记定型）。 */
  _pending_step: TraceStep | null;
  /** 轨迹追加锁（并行组成员并发追加串行化）。 */
  _trace_lock: _Mutex;

  constructor(graph: Graph, options?: RunOptions) {
    this.graph = graph;
    this.options = options ?? new RunOptions();
    // 声明式节点/条件边先经注册表解析（Engine 持有注册表即可解析——
    // 未解析的条件边与声明式节点在编译期被拒绝，绝不静默当静态边误走）
    if (this.options.registries !== null) {
      graph.resolve_conditions(this.options.registries.edges);
      graph.resolve_types(this.options.registries.nodes);
    }
    // 嵌套图占位由执行器注入（图模块不放占位 fn，执行语义归执行器）：
    // 子图名挂载 run_subgraph 包装——编译期节点存在性/边目标/出口校验与
    // Python add_subgraph（nodes[name] = runner）后的形态一致，主循环按
    // 普通节点函数取用即可（嵌套语义集中在 run_subgraph）。
    this._mount_subgraph_nodes(graph);
    this.compiled = graph.compile();
    this._coordinator = new InterruptCoordinator();
    this._event_counter = 0;
    this._event_lock = new _Mutex();
    this._transport_seq = new _TransportSequencer();
    this._graph_digest = graph.digest();
    this._subgraph_engines = new Map<string, EngineBase>();
    this._node_visits = {};
    this._event_log_error_ts = 0;
    this._latest_event_seq = null;
    this._chain_advanced = false;
    this.executed_node_steps = 0;
    // 输入调配管线执行体（assembly 非 null 时启用；激活留痕随事件落库）
    this._assembler =
      this.options.assembly !== null
        ? new InputAssembler(this.options.assembly, {
            aggregator: this.options.assembly_aggregator,
          })
        : null;
    // 结点级成败留痕（沉淀钩子输入）：本 run 的执行轨迹与成本账，不发射
    // 事件（观测侧零影响）。_execute 入口复位；嵌套引擎执行完经合并点并入。
    this._run_trace = [];
    this._node_tokens = new Map<string, number>();
    this._trace_graphs = new Map<string, GraphType>();
    this._pending_step = null;
    this._trace_lock = new _Mutex();
  }

  /** 嵌套子图占位注入：子图名 → run_subgraph 包装（递归到全部嵌套子图；
   *  幂等：已挂载跳过）。 */
  private _mount_subgraph_nodes(graph: Graph): void {
    for (const subgraph of Object.values(graph.subgraphs)) {
      this._mount_subgraph_nodes(subgraph);
    }
    for (const [name, subgraph] of Object.entries(graph.subgraphs)) {
      if (graph.nodes[name] !== undefined) continue;
      const mounted = subgraph;
      graph.nodes[name] = (ctx: unknown) => run_subgraph(mounted, ctx as NodeContext);
    }
  }

  /** 以本实例具体类新建子引擎（同类型实例；嵌套/spawn/分支共用）。 */
  protected _new_engine(graph: Graph, options: RunOptions): this {
    const Ctor = this.constructor as new (g: Graph, opts?: RunOptions) => this;
    return new Ctor(graph, options);
  }

  // ── 抽象执行面（分层链中由上层实现；本文件只钉签名）───────────────

  /** 事件发布：落执行日志（拿 seq）→ 推送全部传输（观测不阻断执行）。 */
  abstract _publish(event: EngineEvent, opts?: { transports?: EngineTransport[] | null }): Promise<void>;

  /** 结点执行边界 token 计账（usage 帧纯算法归集；不发射事件）。 */
  abstract _trace_add_tokens(graph_path: readonly string[], node: string, tokens: number): void;

  /** 主执行循环（顶层与嵌套子图/实例共用）。 */
  abstract _execute(opts: ExecuteOptions): Promise<[Record<string, unknown>, import('../run_result/run_result.js').RunResult]>;
}

// 供分层链/节点上下文直接引用轨迹三态（常量重导出，沿用 Python 模块面）
export { TRACE_SUCCESS, TRACE_FAILED, TRACE_SKIPPED };
export type { NodeContext };
