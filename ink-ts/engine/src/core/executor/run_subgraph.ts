/**
 * 嵌套图节点包装执行（executor.py run_subgraph + schema 继承检查移植；
 * graph.py 的 _subgraph_runner 语义在 TS 由引擎挂载的包装调用本函数）。
 *
 * 子图复用父引擎（共享 storage/transports/budget/coordinator——interrupt
 * 在子图内同样可用），graph_path 追加子图名；子图最终状态整体作为增量返回
 * 父图（输出回流，reducer 合并，绝不静默丢值）。
 *
 * 子图引擎按图内容 digest 缓存（ENG2-6：数据驱动子图每次新建实例，id() 缓存
 * 键永不命中 → 每次重复 compile；digest 键让同定义子图跨实例复用）；复用实例
 * 的事件计数由 _execute 入口复位（每轮从零起算，父引擎按差值合并）。
 *
 * schema 继承检查（ENG2-7）：子图自定义 schema 的 merge reducer 分类与父图
 * 不一致时回流语义错位（子图按自身口径剥离/求差，父图按自身口径合并——同
 * 通道分类不同 = 二次加和或丢值），首跑即显式拒绝。
 *
 * 回流口径（delta = 子图内实际变化，防 reducer 加和翻倍）：子图执行以入口
 * 快照为基，合并累加族通道入口归零（子图内从 0 起算）；回流经
 * subgraph_overlay_delta 按子图自身 schema 求差（additive 按条目差集）。
 */
import { Graph } from '../graph/graph.js';
import { GraphDefinitionError, NodeExecutionError } from '../errors.js';
import { InterruptSignal } from '../interrupt/interrupt_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import { is_merge_reducer } from '../state/reducers.js';
import { subgraph_overlay_delta } from '../state/schema.js';
import type { StateSchema } from '../state/schema.js';
import type { NodeContext } from './_internals.js';
import { _pop_resume_anchor } from './_internals.js';
import { _NodeContextImpl } from './_node_context.js';
import { _sub_engine_options } from './_engine_instance.js';
import { Engine } from './_engine_execute.js';

/**
 * 嵌套子图占位注入：子图名 → run_subgraph 包装（递归到全部嵌套子图；
 * 幂等：已挂载跳过）。
 *
 * 由叶节点 Engine 构造在 super(graph, options) 之前调用——编译期节点存在性/
 * 边目标/出口校验与 Python add_subgraph（nodes[name] = runner）后的形态一致，
 * 主循环按普通节点函数取用即可（嵌套语义集中在 run_subgraph）。挂载职责落
 * 在本模块而非引擎基座，消除 base→subgraph→leaf→base 的模块评估环。
 */
export function _install_subgraph_runners(graph: Graph): void {
  for (const subgraph of Object.values(graph.subgraphs)) {
    _install_subgraph_runners(subgraph);
  }
  for (const [name, subgraph] of Object.entries(graph.subgraphs)) {
    if (graph.nodes[name] !== undefined) continue;
    const mounted = subgraph;
    graph.nodes[name] = (ctx: unknown) => run_subgraph(mounted, ctx as NodeContext);
  }
}

/**
 * 子图 schema 与父图 merge reducer 分类的继承检查（ENG2-7）。
 *
 * 回流语义依赖两端的 merge 分类一致：子图入口按**自身** schema 剥离合并
 * 累加族通道、回流增量按**自身** schema 求差，父图再按**自身** schema
 * 合并——同一通道两端分类不同 = 二次加和（父合并子终态）或丢值（父覆盖子
 * 增量）。声明期（首跑）显式拒绝，不静默错位。
 */
export function _validate_subgraph_schema_inheritance(opts: {
  parent_schema: StateSchema;
  sub_schema: StateSchema;
  subgraph_name: string;
}): void {
  const { parent_schema, sub_schema, subgraph_name } = opts;
  const sub_merge = new Set<string>();
  const parent_merge = new Set<string>();
  for (const [key, channel] of Object.entries(sub_schema.channels)) {
    if (is_merge_reducer(channel.reducer)) sub_merge.add(key);
  }
  for (const [key, channel] of Object.entries(parent_schema.channels)) {
    if (is_merge_reducer(channel.reducer)) parent_merge.add(key);
  }
  const conflict = new Set<string>();
  for (const key of sub_merge) {
    if (!parent_merge.has(key)) conflict.add(key);
  }
  for (const key of parent_merge) {
    if (key in sub_schema.channels && !sub_merge.has(key)) conflict.add(key);
  }
  if (conflict.size > 0) {
    throw new GraphDefinitionError(
      `子图 ${subgraph_name} 的 schema 与父图 merge reducer 声明不一致` +
        `（回流语义错位，拒绝执行）: ${[...conflict].sort()}` +
        '——同通道的 merge 分类必须两端一致（子图未声明为 merge 的通道父图' +
        '不得声明为 merge；子图声明为 merge 的通道父图必须同样声明）',
    );
  }
}

/**
 * 嵌套图节点包装执行（graph.py _subgraph_runner 调用面）。
 *
 * @param subgraph 子图实例。
 * @param parent_ctx 父图节点上下文（事件透传/中断共享/版本链归属）。
 * @returns 子图最终状态增量（输出回流，父图 reducer 合并，绝不静默丢值）。
 * @throws InterruptSignal 子图内中断（提升为父图挂起卡，重入语义一致）。
 * @throws NodeExecutionError 子图终态为 ERROR（向父图传播，父层节点循环按
 *   error_on_exception 决定终止或跳过）。
 */
export async function run_subgraph(
  subgraph: Graph,
  parent_ctx: NodeContext,
): Promise<Record<string, unknown> | null> {
  const parent = parent_ctx as _NodeContextImpl;
  const engine = parent._engine as Engine;
  // 子图允许自定义 schema（业务子图按自身通道声明），未声明时继承父引擎 schema
  const sub_schema = ((subgraph.schema as StateSchema | null) ?? engine.options.schema) as StateSchema | null;
  if (subgraph.schema !== null && engine.options.schema !== null) {
    _validate_subgraph_schema_inheritance({
      parent_schema: engine.options.schema,
      sub_schema: subgraph.schema as StateSchema,
      subgraph_name: subgraph.name,
    });
  }
  let sub_engine = engine._subgraph_engines.get(subgraph.digest()) ?? null;
  if (sub_engine === null) {
    sub_engine = new Engine(subgraph, _sub_engine_options(engine.options, { schema: sub_schema }));
    engine._subgraph_engines.set(subgraph.digest(), sub_engine);
  }
  // 共享父引擎 coordinator：子图内 interrupt 重入与父图同一通道
  sub_engine._coordinator = engine._coordinator;
  // 事件推送保序协调器跨引擎共享（子图与父引擎同一 thread 事件日志/传输链）
  sub_engine._transport_seq = engine._transport_seq;
  const entry_state: Record<string, unknown> = { ...parent_ctx.state };
  // 入口剥离合并累加族通道（merge_metrics/merge_dicts）：子图内从 0 起算，
  // 回流增量 = 子图内新增（父图 reducer 加和恰好一次，防二次加和翻倍）。
  // 按子图自身 schema 判定剥离集合（分类声明化：业务注册的自定义合并 reducer
  // 同样生效；子图未声明为合并累加族的通道保持父值透传）。
  const schema = sub_engine.options.schema;
  if (schema !== null) {
    for (const [key, channel] of Object.entries(schema.channels)) {
      if (is_merge_reducer(channel.reducer) && key in entry_state) {
        entry_state[key] = {};
      }
    }
  }
  const sub_path = [...parent_ctx.graph_path, subgraph.name];
  // 子图首写 checkpoint 的 parent 须跟随父链尾（版本链跨引擎线性连续——子图
  // 进入时链尾 = 父层最近 checkpoint；置位后由首写处统一查询并复位）
  if (engine.options.storage !== null) {
    sub_engine._chain_advanced = true;
  }
  const [final_state, sub_result] = await sub_engine._execute({
    state: entry_state,
    thread_id: parent._thread_id,
    round_id: parent_ctx.round_id,
    // 恢复锚点消费即清除：同 run 内条件边回路二次进入同名子图不得复用旧锚点
    // "恢复"（会跳过子图前段节点或直接收尾回流陈旧状态）
    resume_from: _pop_resume_anchor(parent_ctx.resume_map, sub_path),
    trace_id: parent_ctx.trace_id,
    queue: null,
    graph_path: sub_path,
    transports: parent._transports, // 继承父传输链（含顶层队列）
    resume_map: parent_ctx.resume_map ?? null,
  });
  // 子图 checkpoint 推进版本链：父引擎下次写 checkpoint 前须查询链尾作为
  // parent（版本链严格线性；顺序执行路径则复用内存态，免每节点查询）。
  // 置于中断提升前：子图中断同样推进过链尾（中断 checkpoint 已写入）。
  if (engine.options.storage !== null) {
    engine._chain_advanced = true;
  }
  // 子图事件并入父引擎计数（父结果 events_emitted 含子图发射量）
  engine._event_counter += sub_engine._event_counter;
  // 子图轨迹并入父引擎（结点级成败留痕跨层连续，沉淀回放同源）
  engine._trace_merge_from(sub_engine);
  // 子图事件 seq 同步回父引擎：子图事件已落父 thread 日志，父引擎后续
  // checkpoint 锚点须含子图事件 seq（否则恢复时子图事件被重复重放）。
  if (sub_engine._latest_event_seq !== null) {
    engine._latest_event_seq =
      engine._latest_event_seq === null
        ? sub_engine._latest_event_seq
        : Math.max(engine._latest_event_seq, sub_engine._latest_event_seq);
  }
  // 子图内中断 → 提升为父图 interrupt（挂起卡跨嵌套层保留，重入语义一致）
  if (sub_result.interrupt !== null) {
    throw new InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload);
  }
  // 子图终态为 ERROR → 向父图传播（与顶层 error_on_exception 语义一致：子图
  // 失败不得静默吞没，父图照常回流陈旧部分增量会掩盖数据损坏）。父层节点
  // 循环捕获后按 error_on_exception 决定终止或跳过。
  if (sub_result.reason === TerminateReason.ERROR) {
    throw new NodeExecutionError(
      subgraph.name,
      new Error(sub_result.error ?? `子图执行失败: ${subgraph.name}`),
    );
  }
  // 子图终态 → 父图增量（delta = 子图内实际变化，防 reducer 加和翻倍）：
  // 分类判定用子图自身 schema：与入口剥离（上方同口径）一致，子图自定义
  // schema 的 additive/merge 声明不回流入父口径错位。
  return subgraph_overlay_delta(entry_state, final_state, sub_engine.options.schema);
}
