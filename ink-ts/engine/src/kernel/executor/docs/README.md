# executor（kernel/executor）

执行引擎：回合主循环/嵌套子图/spawn 实例/推演分支/多径展开的状态机驱动与装配（executor.py 移植），15 层抽象继承链 + 前/后半段单循环，checkpoint 版本链与事件日志统一经注入 Storage seam 落库。

## 文件
- `index.ts` — 汇出口：`Engine`/`EngineBase`/`ExecuteOptions`/`run_subgraph`/`run_agent_scope`/`_validate_subgraph_schema_inheritance`/`_NodeContextImpl`/`NodeContext`/`_select_next_node`/`_locate_next` + core `RunOptions`/`RunResult` re-export；头注为文件拆分纪律
- `contract.ts` — 机制契约 `executor_contract`：effects=[storage_seam]，depends=[budget,interrupt,llm,multipath,recovery,settle,simulation,spawn]
- `_engine_base.ts` — 分层链根：`EngineBase` 抽象基座（构造/全部实例字段/`_new_engine`；抽象 `_execute`/`_publish`/`_trace_add_tokens`）+ `ExecuteOptions`
- `_engine_events.ts` — `EngineEvents extends EngineBase`：事件发布（事件锁内分配 seq）、按 seq 保序传输、`update_state` 外部状态补丁、`get_latest_interrupt`、`publish_event`、`_maybe_compact_chain` 链级 rebase、静态 `decision_anchor`
- `_engine_trace.ts` — `EngineTrace extends EngineEvents`：结点级成败留痕（open/mark_failed/mark_skipped/close_pending/add_tokens/append_member/merge_from）+ `_settle_run` 沉淀钩子
- `_engine_run.ts` — `EngineRun extends EngineTrace`：流式 `run`（队列传输）与非流式 `ainvoke`、`_validate_entry_mode`（resume_from/continue_chain 互斥）、`_record_run_metrics`、`swap_branch` 换选
- `_engine_instance.ts` — `EngineInstance extends EngineRun`：`_resolve_graph_data` 数据形态子图重建、`_make_instance_engine` 实例工厂（共享 coordinator/传输保序协调器）、`_sub_engine_options` 配置继承
- `_engine_checkpoint.ts` — `EngineCheckpoint extends EngineInstance`：统一 `_write_checkpoint`（event_seq 锚点/链尾跟随/fork 首写跳验/失败回滚孤立事件）
- `_engine_spawn.ts` — `EngineSpawn extends EngineCheckpoint`：`run_spawned` 子任务并发展开（fan_out、独立 checkpoint 子链、失败剔除、中断提升）
- `_engine_simulate.ts` — `EngineSimulate extends EngineSpawn`：`run_simulated` 决策点推演（分支独立子链→评估→择优/换选，落选分支留轨迹树引用）
- `_engine_parallel.ts` — `EngineParallel extends EngineSimulate`：`_run_parallel_group` 并行节点组（状态快照隔离、并发池调度、首信号收口、成员全量 try/catch）
- `_engine_plan.ts` — `EnginePlan extends EngineParallel`：`_plan_advance` 计划游标推进（条件门/节点步/工作步内联消耗 + 工作步 checkpoint `plan_step` 标记）、`_eval_condition`、`_execute_plan_work_step`、`_run_plan_spawns`
- `_engine_multipath.ts` — `EngineMultipath extends EnginePlan`：`_run_multipath` 多径展开调度（MultipathRunner 接线 + 证据/审计/缓存回馈 seam）与降级单径
- `_engine_execute_helpers.ts` — `EngineExecuteHelpers extends EngineMultipath`：`_run_node_attempts` 节点重试执行（InterruptSignal 挂起/脱敏/重试耗尽收口）
- `_engine_loop_front.ts` — `EngineLoopFront extends EngineExecuteHelpers`：主循环前半段（恢复首轮、步数/回路/预算护栏、预装配、节点执行、保留键清单提取、增量合并、终止信号）→ `'break'|'proceed'|'continue'`
- `_engine_loop_back.ts` — `EngineLoopBack extends EngineLoopFront`：主循环后半段（spawn/推演/多径展开 → checkpoint → 计划推进/边出口定位）→ `'break'|'continue'`
- `_engine_execute.ts` — `Engine extends EngineLoopBack` 叶类：构造前置挂载子图占位（拆 base→subgraph→leaf 模块环）；`_execute` 主循环装配（每轮复位、恢复解析 `resolve_resume`、恢复起点定位、LoopState、front/back 循环、审批卡事件、终态 checkpoint、RunResult）
- `run_subgraph.ts` — 嵌套子图包装执行（父引擎复用、digest 缓存子引擎、schema 继承检查、merge 通道入口归零、delta 回流、中断/ERROR 传播）+ `_install_subgraph_runners` 占位注入 + `run_agent_scope` 同步单分支
- `_node_context.ts` — `_NodeContextImpl implements NodeContext`：emit/interrupt/terminate/spawn/assemble/preassemble/account_usage/run_agent_scope 接线
- `_loop_types.ts` — `LoopState` 主循环可变循环局部状态（front/back 共享）
- `_internals.ts` — 内部件集中层：日志留痕 seam、确定性时钟/id seam、`_Mutex`/`_AsyncQueue`/`_QueueTransport`/`_TransportSequencer`、`_PlanAdvance`/`_PlanWorkOutcome`、`NodeContext` 协议、边出口定位（`_select_next_node`/`_locate_next`）、恢复判据、`_merge_overlay`

## 依赖
- 上游（本目录实际 import）：core（json/errors/events/graph/graph_types/plan/state schema+reducers/storage+storage_records/run_result/security/assembly+input_assembler/chain_rebase/fanout/context_types/contracts）；kernel（budget/interrupt/llm guard+_guard_types/multipath/recovery/settle/simulation/spawn；path_assembler 仅 type import types；registry/contract_types+ports 契约面）
- 下游（实际 import 本目录）：`src/index.ts:111-112`（公共面）；`kernel/runtime/_runtime_engine.ts`（值 import `Engine`+`RunOptions`）、`_runtime_rounds.ts`（type）；`kernel/path_assembler/canary.ts`（值 import，canary 试跑复用）；`kernel/registry/contracts.ts:22`（`executor_contract` 入 34 项清单）；`test/kernel/executor/`；hosts 经 `@ink-ts/engine` 公共面（`hosts/lib/test/_graphs.ts` type import `Engine`）
