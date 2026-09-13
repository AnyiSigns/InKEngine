# executor（graph/executor）

执行引擎：回合主循环/嵌套子图的状态机驱动与装配（executor.py 移植），10 层抽象继承链（base→trace→execute→loop 级）+ 前/后半段单循环，checkpoint 版本链与事件日志统一经注入 Storage seam 落库。spawn/推演/多径/计划展开段已随 P8+S1 摘链退役（Simulate/Multipath/Plan/Spawn/Parallel 五类整体消亡），并行组批量执行段折入 `_engine_execute_helpers.ts`。

## 文件
- `index.ts` — 汇出口：`Engine`/`EngineBase`/`ExecuteOptions`/`run_subgraph`/`run_agent_scope`/`_validate_subgraph_schema_inheritance`/`_NodeContextImpl`/`NodeContext`/`_select_next_node`/`_locate_next` + core `RunOptions`/`RunResult` re-export；头注为文件拆分纪律
- `contract.ts` — 机制契约 `executor_contract`：effects=[storage_seam]，depends=[budget,interrupt,llm,recovery,settle]
- `_engine_base.ts` — 分层链根：`EngineBase` 抽象基座（构造/全部实例字段/`_new_engine`；抽象 `_execute`/`_publish`/`_trace_add_tokens`）+ `ExecuteOptions`
- `_engine_events.ts` — `EngineEvents extends EngineBase`：事件发布（事件锁内分配 seq）、按 seq 保序传输、`update_state` 外部状态补丁、`get_latest_interrupt`、`publish_event`、`_maybe_compact_chain` 链级 rebase
- `_engine_trace.ts` — `EngineTrace extends EngineEvents`：结点级成败留痕（open/mark_failed/mark_skipped/close_pending/add_tokens/append_member/merge_from）+ `_settle_run` 沉淀钩子
- `_engine_run.ts` — `EngineRun extends EngineTrace`：流式 `run`（队列传输）与非流式 `ainvoke`、`_validate_entry_mode`（resume_from/continue_chain 互斥）、`_record_run_metrics`
- `_engine_instance.ts` — `EngineInstance extends EngineRun`：`_sub_engine_options` 配置继承（`_resolve_graph_data`/`_make_instance_engine` 随展开段退役，P8+S1）
- `_engine_checkpoint.ts` — `EngineCheckpoint extends EngineInstance`：统一 `_write_checkpoint`（event_seq 锚点/链尾跟随/fork 首写跳验/失败回滚孤立事件）
- `_engine_execute_helpers.ts` — `EngineExecuteHelpers extends EngineCheckpoint`：`_run_node_attempts` 节点重试执行（InterruptSignal 挂起/脱敏/重试耗尽收口）+ `_run_parallel_group` 并行组批量执行（S1 自 `_engine_parallel.ts` 折入：状态快照隔离、并发池调度、首信号收口、成员全量 try/catch）
- `_engine_loop_front.ts` — `EngineLoopFront extends EngineExecuteHelpers`：主循环前半段（恢复首轮、步数/回路/预算护栏、节点执行、增量合并、终止信号）→ `'break'|'proceed'|'continue'`
- `_engine_loop_back.ts` — `EngineLoopBack extends EngineLoopFront`：主循环后半段（checkpoint → 下一步定位/边出口）→ `'continue'|'break'`
- `_engine_execute.ts` — `Engine extends EngineLoopBack` 叶类：构造前置挂载子图占位（拆 base→subgraph→leaf 模块环）；`_execute` 主循环装配（每轮复位、恢复解析 `resolve_resume`、恢复起点定位、LoopState、front/back 循环、审批卡事件、终态 checkpoint、RunResult）
- `run_subgraph.ts` — 嵌套子图包装执行（父引擎复用、digest 缓存子引擎、schema 继承检查、merge 通道入口归零、delta 回流、中断/ERROR 传播）+ `_install_subgraph_runners` 占位注入 + `run_agent_scope` 同步单分支
- `_node_context.ts` — `_NodeContextImpl implements NodeContext`：emit/interrupt/terminate/account_usage/run_agent_scope 接线
- `_loop_types.ts` — `LoopState` 主循环可变循环局部状态（front/back 共享）
- `_internals.ts` — 内部件集中层：日志留痕 seam、确定性时钟/id seam、`_Mutex`/`_AsyncQueue`/`_QueueTransport`/`_TransportSequencer`、`_PlanWorkOutcome`（并行组结果形态）、`NodeContext` 协议、边出口定位（`_select_next_node`/`_locate_next`）、恢复判据、`_merge_overlay`

## 依赖
- 上游（本目录实际 import）：core（json/errors/events/graph/graph_types/plan/state schema+reducers/storage+storage_records/run_result/security/chain_rebase/context_types/contracts；assembly+input_assembler 消费已随组装链路退役删除 W7-B；fanout 随 P8+S1 退役）；机制层（budget/interrupt/llm guard+_guard_types/recovery/settle——multipath/simulation/spawn 依赖已随展开段退役，P8+S1；registry/contract_types+ports 契约面）
- 下游（实际 import 本目录）：`src/index.ts`（公共面）；`dock/registry/contracts.ts`（`executor_contract` 入 28 项清单）；`loop/runtime`（engine_turn_runner 建引擎跑回合）；`test/graph/executor/`；hosts 经 `@ink-ts/engine` 公共面（`kernel/path_assembler/canary.ts` 试跑等消费已随组装链路退役删除，W7-B）
