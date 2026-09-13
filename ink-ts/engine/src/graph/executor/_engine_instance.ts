/**
 * 引擎实例引擎工厂面（executor.py Engine 的 _make_instance_engine 段移植
 * 的存续部分：子引擎配置继承）。
 *
 * 实例引擎：独立实例（并发安全，不复用图级缓存——实例间互不干扰），
 * 共享父引擎存储/schema/预算/传输配置；coordinator 共享（实例内
 * interrupt 重入与父图同一通道）；事件推送保序协调器跨引擎共享。
 *
 * 数据形态子图解析（_resolve_graph_data）与 _make_instance_engine 已随
 * spawn/simulate/multipath/plan 展开段退役（P8+S1）；嵌套子图经 run_subgraph
 * 直接构造 Engine，仅复用本模块的 _sub_engine_options 继承面。
 */
import { RunOptions } from '../../core/run_result/run_result.js';
import type { StateSchema } from '../../core/state/schema.js';
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
    // 子链护栏随实例传播：嵌套深度上限同口径，且子链深度 = 父深度 + 1
    // （嵌套校验基准递进）
    spawn_max_depth: parent.spawn_max_depth,
    // 执行回路护栏随实例传播（实例内同样有成本上界）
    max_cycle: parent.max_cycle,
    spawn_depth: init.spawn_depth ?? parent.spawn_depth,
    // 建图注册表随实例传播（声明式节点/条件边在实例层同样可解析）
    registries: parent.registries,
    // 并行节点组并发上限随实例传播
    parallel_concurrency: parent.parallel_concurrency,
    // 系统信号/链级 rebase 窗口随实例传播：嵌套层不静默漂移
    system_events: parent.system_events,
    checkpoint_keep: parent.checkpoint_keep,
  });
}

/** 实例引擎分层段（Engine 方法群；配置继承在 run_subgraph 侧消费）。 */
export abstract class EngineInstance extends EngineRun {}
