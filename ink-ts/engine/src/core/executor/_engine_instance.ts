/**
 * 引擎数据形态子图解析/实例引擎工厂面（executor.py Engine 的
 * _resolve_graph_data/_make_instance_engine 段移植）。
 *
 * - 数据形态（spawn 清单/计划/推演分支携带的 dict 子图）经注册表重建：
 *   缺失注册表显式报错，重建走完整校验（validate=True：悬挂入口/出口/边
 *   目标等结构错误在解析期暴露，非法图定义不延后到执行期）；
 * - 实例引擎：独立实例（并发安全，不复用图级缓存——实例间互不干扰），
 *   共享父引擎存储/schema/预算/传输配置；coordinator 共享（实例内
 *   interrupt 重入与父图同一通道）；事件推送保序协调器跨引擎共享。
 *
 * 成本护栏整体继承：父层显式禁用/收紧的 spawn/推演/回路限制在实例层不旁落；
 * 子链深度 = 父深度 + 1（嵌套校验基准递进，见展开入口）。
 */
import { Graph } from '../graph/graph.js';
import { RunOptions } from '../run_result/run_result.js';
import type { StateSchema } from '../state/schema.js';
import { EngineRun } from './_engine_run.js';

/**
 * 子引擎配置继承（镜像 Python 各子引擎 RunOptions 的传播字段集）。
 *
 * Python 侧在 _make_instance_engine/run_subgraph 处显式列出的传播字段：
 * 未列出字段（metrics/settle/domain 等）按 RunOptions
 * 默认值落——子引擎不漂移也不外带观测件。
 */
export function _sub_engine_options(
  parent: RunOptions,
  init: { schema?: StateSchema | null; spawn_depth?: number } = {},
): RunOptions {
  return new RunOptions({
    storage: parent.storage,
    schema: init.schema !== undefined ? init.schema : parent.schema,
    budget: parent.budget,
    transports: parent.transports,
    max_node_retries: parent.max_node_retries,
    error_on_exception: parent.error_on_exception,
    // 成本护栏整体继承：父层显式禁用/收紧的 spawn 限制在实例层不旁落
    max_spawns: parent.max_spawns,
    spawn_concurrency: parent.spawn_concurrency,
    // 子链护栏随实例传播：嵌套深度上限与分支步数上限同口径，且子链深度
    // = 父深度 + 1（嵌套校验基准递进）
    spawn_max_depth: parent.spawn_max_depth,
    simulate_max_branch_steps: parent.simulate_max_branch_steps,
    // 执行回路护栏随实例传播（实例内同样有成本上界）
    max_cycle: parent.max_cycle,
    spawn_depth: init.spawn_depth ?? parent.spawn_depth,
    // 建图注册表与计划配置随实例传播（数据形态子图/计划条件在实例层同样
    // 可解析；计划策略/护栏口径与父层一致）
    registries: parent.registries,
    plan_policy: parent.plan_policy,
    max_plan_steps: parent.max_plan_steps,
    plan_workflow: parent.plan_workflow,
    parallel_concurrency: parent.parallel_concurrency,
    // 推演配置随实例传播（嵌套决策点/分支内再推演同口径：评估器/调配策略/
    // 分支护栏与父层一致）
    evaluator: parent.evaluator,
    branch_mixer: parent.branch_mixer,
    max_simulations: parent.max_simulations,
    simulate_concurrency: parent.simulate_concurrency,
    // 输入调配随实例传播（子任务/分支的执行面同样统一走调配管线）
    assembly: parent.assembly,
    assembly_sources: parent.assembly_sources,
    // 系统信号/链级 rebase 窗口随实例传播：嵌套层不静默漂移
    system_events: parent.system_events,
    checkpoint_keep: parent.checkpoint_keep,
  });
}

/** 实例工厂/数据形态解析分层段（Engine 方法群）。 */
export abstract class EngineInstance extends EngineRun {
  /**
   * 子图数据形态解析：Graph 直通；图定义数据经注册表重建。
   *
   * 数据形态（spawn 清单/计划/推演分支携带的 dict 子图）要求引擎注入
   * 注册表（RunOptions.registries）——缺失时显式报错，不静默降级为执行
   * 错误。重建走完整校验（validate=True：悬挂入口/出口/边目标等结构错误
   * 在解析期暴露，与 harness 注册侧同口径）。
   */
  _resolve_graph_data(data: unknown): Graph {
    if (data instanceof Graph) {
      return data;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`子图须为 Graph 或图定义数据: ${data === null ? 'null' : typeof data}`);
    }
    const registries = this.options.registries;
    if (registries === null) {
      throw new Error('图定义数据需注册表解析（RunOptions.registries 未注入）');
    }
    return Graph.from_dict(data as Record<string, unknown>, {
      registry: registries.nodes,
      edge_registry: registries.edges,
      validate: true,
    });
  }

  /**
   * 实例引擎：独立实例（并发安全，不复用图级缓存——实例间互不干扰）。
   *
   * 共享父引擎存储/schema/预算/传输配置；coordinator 共享（实例内 interrupt
   * 重入与父图同一通道）。实例链 checkpoint 的图版本 = 子图自身指纹：跨引擎
   * 同源漂移由实例链自身的恢复校验覆盖（父链不重放实例事件，无需并入父
   * 指纹——图版本校验作用域 = 各自引擎的恢复锚点）。
   *
   * @param subgraph 子图定义。
   * @param spawn_depth 子单元所在子链深度（子图/实例/分支执行引擎携带；
   *   嵌套校验基准 = 该深度，超限拒绝由展开入口执行）。
   */
  _make_instance_engine(subgraph: Graph, spawn_depth: number): this {
    const sub_engine = this._new_engine(
      subgraph,
      _sub_engine_options(this.options, {
        schema: (subgraph.schema as StateSchema | null) ?? this.options.schema,
        spawn_depth,
      }),
    );
    sub_engine._coordinator = this._coordinator;
    // 事件推送保序协调器跨引擎共享：实例与父引擎推进同一 thread 事件
    // 日志（seq 全局）、推送同一传输链——独立协调器会让实例后续事件
    // 因本引擎缺孔永远卡在缓冲（见 _TransportSequencer）
    sub_engine._transport_seq = this._transport_seq;
    return sub_engine;
  }
}
