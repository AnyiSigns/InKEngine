# graph/executor — 执行引擎状态机（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

引擎执行面机制件：把编译图驱动为「单循环状态机」——每节点完成写一次 checkpoint 快照（版本链），无 Pregel 中间状态，回路任意点可恢复。同时承载嵌套子图的执行语义与统一 checkpoint/事件写入。`contract.ts` 自述：本机制是回合执行引擎的驱动方而非 rounds_port 消费方。

spawn 实例/推演分支/多径展开/计划推进四类展开段已随 P8+S1 摘链退役（`_engine_spawn/_engine_simulate/_engine_parallel/_engine_plan/_engine_multipath` 五文件消亡），继承链重接为 10 层：`EngineBase→EngineEvents→EngineTrace→EngineRun→EngineInstance→EngineCheckpoint→EngineExecuteHelpers→EngineLoopFront→EngineLoopBack(→Engine)`；并行组批量执行段折入 `_engine_execute_helpers.ts`。

## 文件与职责

16 文件 = 10 层抽象继承链 + 4 个横向内部件 + 汇出口/契约/子图通道：

| 层（extends 链序） | 文件 | 职责 |
| --- | --- | --- |
| 1 根 | `_engine_base.ts` | `EngineBase` 字段/装配（graph.compile、coordinator、事件锁、传输保序协调器、图 digest、子图引擎缓存、轨迹账）+ `ExecuteOptions`；抽象 `_publish`/`_trace_add_tokens`/`_execute` |
| 2 | `_engine_events.ts` | 事件发布（锁内 append 拿 seq、锁外按 seq 保序推送、失败降频）、`update_state`、`publish_event`、`_maybe_compact_chain` |
| 3 | `_engine_trace.ts` | 结点成败留痕 + token 账 + `_settle_run`（钩子异常不阻断） |
| 4 | `_engine_run.ts` | `run`/`ainvoke` 入口、入口模式互斥校验、回合指标 |
| 5 | `_engine_instance.ts` | `_sub_engine_options` 继承集（实例工厂与数据形态子图重建随展开段退役，P8+S1） |
| 6 | `_engine_checkpoint.ts` | `_write_checkpoint` 链写不变量单点 + 失败回滚孤立事件 |
| 7 | `_engine_execute_helpers.ts` | `_run_node_attempts`（重试/脱敏/挂起态构造）+ `_run_parallel_group`（并行组批量执行，S1 自 `_engine_parallel.ts` 折入） |
| 8 | `_engine_loop_front.ts` | 单迭代前半段：恢复首轮/步数·回路·预算护栏/节点执行/增量合并/终止信号 |
| 9 | `_engine_loop_back.ts` | 单迭代后半段：checkpoint → 下一步定位/边出口 |
| 10 叶 | `_engine_execute.ts` | `Engine`（构造挂载子图占位）+ `_execute`：恢复解析/起点定位/`LoopState`/循环收敛/审批卡事件/终态快照/`RunResult` |
| 横向 | `run_subgraph.ts`、`_node_context.ts`、`_loop_types.ts`、`_internals.ts` | 嵌套子图通道与 agent 作用域；节点上下文协议实现；循环局部状态；并发原语/确定性 seam/定位纯函数 |
| 面 | `index.ts`、`contract.ts` | 汇出口与机制契约 |

## 对外契约面

- 公共面逐名核对（`src/index.ts`）：值 `Engine`、`run_subgraph`；类型 `EngineBase`、`ExecuteOptions`、`NodeContext`。目录 `index.ts` 另导出 `run_agent_scope`/`_validate_subgraph_schema_inheritance`/`_NodeContextImpl`/`_select_next_node`/`_locate_next`（仓内可达，如测试直用 `_NodeContextImpl`），不在公共面。
- 机制契约：`executor_contract = { id: 'executor', contract: { effects: [PORT_STORAGE_SEAM='storage_seam'] }, depends: ['budget','interrupt','llm','recovery','turn_settle'] }`；`llm_port`/`exec_envelope`/`rounds_port` 不列（`path_assembler` 不列项已随机制退役 W7-B；multipath/simulation/spawn 依赖已随展开段退役，P8+S1；contract.ts 头注逐项说明理由）。

## 数据形态

- 循环状态 `LoopState`：current/current_state/last_checkpoint/interrupt_state/reason/error_msg/parent_id/fork_write/events_before/skip_first_node/thread_id/chain_thread/first_timeline_emit。
- 内部传输形态：`_PlanWorkOutcome`（并行组 overlay 与 interrupt/terminate/error 信号互斥）/`NodeAttemptOutcome`/`WriteCheckpointOptions`/`_TraceCarrier`。
- 协议常量：`TerminateReason`（reply/stop/budget_exceeded/error/interrupted）；事件日志降频窗 5000ms。
- 状态合并：`_merge_overlay`（schema reducer 或裸覆盖）；恢复判据 `_resume_path_key`。

## Seam 与 IO 边界

- effects 声明 storage_seam：checkpoint/事件日志仅经注入的 `RunOptions.storage` 落库（0-IO：不自持 IO）；并发写保护在存储层链尾乐观锁。
- 确定性 seam：`_set_clock`（epoch 秒/毫秒单调戳）、`_default_id`（进程内单调 id）；日志留痕 `_set_log_sinks`（缺省静默，观察面）。
- 节点标签、预算、沉淀钩子均为宿主注入。

## 装配与消费

- 值面装配：`loop/runtime/engine_turn_runner.ts` 值 import `Engine`（主线回合引擎）；`dock/registry/contracts.ts` 收入 28 项全量契约清单（`path_assembler`/`pool_governance`/`thread_skeleton` 契约随组装链路退役 W7-B；simulation/multipath/spawn 契约随展开段退役，P8+S1）；hosts 经公共面。
- 展开关系：run_subgraph = 同一 `Engine._execute` 通道的内联子图（digest 缓存、schema 继承检查 ENG2-7、merge 通道入口归零 + delta 回流）。
- 错误语义要点：嵌套深度/回路超限/预算超限 fail-closed；并行组部分失败剔除（`error_on_exception` 决定终止或跳过）；子图 ERROR 不静默回流；中断统一提升父图挂起卡；checkpoint 写失败回滚孤立事件后重抛。

## 不变式与门禁

- 机制三键：依赖单向 DAG——depends 5 项均为值面 import 已核实；runtime depends 闭包——canary/宿主复用经公共面，无机制反向值依赖；零自持 IO——effects 仅 storage_seam，事件/checkpoint 全经注入端口。
- gate 规则：16 文件无 `node:*`/第三方/宿主词；`_internals.ts` 带门禁豁免头注（超限集中层）。
- 版本链不变式（`_write_checkpoint` 单点维护）：event_seq 取内存态锚点、链尾跟随随写随复位、fork 首写跳过链尾校验、失败回滚孤立事件。

## 测试

`test/graph/executor/` 镜像测试 8 文件（7 `.test.ts` + `helpers.ts`）：

- `executor.test.ts` — 线性/条件边/循环执行、checkpoint 恢复与 StorageError、terminate 语义、异常脱敏/重试/预算/max_cycle 护栏、编辑重放与 event_seq 增量重放、跨实例恢复。
- `executor_chain_regression.test.ts` — P8+S1 摘链回归锁：单节点/多节点线性/条件边/嵌套子图/挂起注入重入/checkpoint 恢复/流式事件序/异常快照（摘链前后皆须全绿）。
- `executor_parallel_group.test.ts` — 并行组批量执行直调（S1 折入保留面）：声明序合并/失败剔除/首信号收口/预算信号/并发限流。
- `executor_loop_edges.test.ts` — kind=loop 回边执行/失控截止/单节点自环。
- `executor_subgraph.test.ts` — graph_path/回流/共享 coordinator 中断/ERROR 上抛/事件计入锚点/additive·merge 通道/digest 缓存/schema 继承拒绝/子图恢复。
- `executor_recovery.test.ts` — 挂起持久化+注入重入、敏感键剥离、注入一次性清理。

## 疑点与不一致

1. `_internals.ts` 门禁豁免头注写「超限(391 行)」，文件实际行数可能漂移——头注与实际行数漂移。
2. `_internals._locate_next` docstring 称「两者皆 null = 图定义不完备」，代码在该情形返回 `[STOP, null]`，「两者皆 null」返回形态在代码中不存在；内层 `if (!graph.exits.has(current))` 仅在出口节点带条件边且全不满足时为假。
3. （W7-B 已解）曾记「`contract.ts` 头注称依赖单向 path_assembler→executor，但 `_engine_multipath.ts` 自 `../path_assembler/types.js` type import（AssemblyCandidate/AssemblyRequest）」——组装机制与 canary 已退役，`_engine_multipath.ts` 已随 P8+S1 删除，该疑点随退役消解。
4. `_engine_base.ts` 对 `core/graph/graph.js` 双重 import（值 `Graph` + 别名 `GraphType` 仅类型），同文件两个名字指同一类型。
