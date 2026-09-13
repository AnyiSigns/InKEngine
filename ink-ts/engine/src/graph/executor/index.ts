/**
 * 执行引擎公共 API 汇出口（executor.py __all__ 移植）。
 *
 * 公共面与 Python ``__all__`` 对齐：Engine/RunOptions/RunResult 为主体，
 * 另导出嵌套图包装执行（run_subgraph）与节点上下文协议/实现（供宿主节点
 * 函数按协议书写、harness/测试经 _NodeContextImpl 直接驱动嵌套执行）。
 *
 * 文件拆分纪律（executor.py 3197 行按机制边界拆文件；spawn/推演/多径/计划
 * 展开段已随 P8+S1 摘链退役，继承链重接为 base→trace→execute→loop 级）：
 * - _internals：模块级机制/数据形态/确定性 seam；
 * - _node_context：_NodeContextImpl（节点协议实现）；
 * - _engine_base：Engine 字段/装配（抽象基座）；
 * - _engine_events：事件发布/状态修补/链压缩；
 * - _engine_trace：结点级成败留痕/沉淀钩子；
 * - _engine_run：run/ainvoke 入口；
 * - _engine_instance：子引擎配置继承；
 * - _engine_checkpoint：统一 checkpoint 写入；
 * - _engine_execute_helpers：节点重试/VTM 验证门控子过程 + 并行组批量执行；
 * - _engine_execute：主执行循环（Engine 叶节点）；
 * - run_subgraph：嵌套图包装执行 + schema 继承检查。
 */
export { Engine } from './_engine_execute.js';
export type { EngineBase } from './_engine_base.js';
export type { ExecuteOptions } from './_engine_base.js';
export { run_subgraph, run_agent_scope, _validate_subgraph_schema_inheritance } from './run_subgraph.js';
export { _NodeContextImpl } from './_node_context.js';
export type { NodeContext } from './_internals.js';
export { RunOptions, RunResult } from '../../core/run_result/run_result.js';
export { _select_next_node, _locate_next } from './_internals.js';
