# kernel/executor — 执行引擎状态机（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

引擎执行面机制件：把编译图驱动为「单循环状态机」——每节点完成写一次 checkpoint 快照（版本链），无 Pregel 中间状态，回路任意点可恢复。同时承载嵌套子图/spawn 实例/推演分支/多径展开四类展开的执行语义与统一 checkpoint/事件写入。`contract.ts` 自述：本机制是回合执行引擎的驱动方而非 rounds.port 消费方。

## 文件与职责

21 文件 = 15 层抽象继承链（每个 `EngineXxx extends` 上一层的 `EngineXxx`）+ 3 个横向内部件 + 汇出口/契约/子图通道：

| 层（extends 链序） | 文件 | 职责 |
| --- | --- | --- |
| 1 根 | `_engine_base.ts` | `EngineBase` 字段/装配（graph.compile、coordinator、事件锁、传输保序协调器、图 digest、子图引擎缓存、轨迹账）+ `ExecuteOptions`；抽象 `_publish`/`_trace_add_tokens`/`_execute` |
| 2 | `_engine_events.ts` | 事件发布（锁内 append 拿 seq、锁外按 seq 保序推送、失败降频）、`update_state`、`publish_event`、`_maybe_compact_chain`、`decision_anchor` |
| 3 | `_engine_trace.ts` | 结点成败留痕 + token 账 + `_settle_run`（钩子异常不阻断） |
| 4 | `_engine_run.ts` | `run`/`ainvoke` 入口、入口模式互斥校验、回合指标、`swap_branch` |
| 5 | `_engine_instance.ts` | 数据形态子图重建 + 实例工厂 + `_sub_engine_options` 继承集 |
| 6 | `_engine_checkpoint.ts` | `_write_checkpoint` 链写不变量单点 + 失败回滚孤立事件 |
| 7 | `_engine_spawn.ts` | `run_spawned`（ENG3-12 spawn_start/end 兜底、深度/步数护栏） |
| 8 | `_engine_simulate.ts` | `run_simulated`（评估剔除、mixer 调配、换选路径） |
| 9 | `_engine_parallel.ts` | `_run_parallel_group`（成员隔离快照、并发池、首信号收口） |
| 10 | `_engine_plan.ts` | `_plan_advance`/`_eval_condition`/`_execute_plan_work_step`/`_run_plan_spawns` |
| 11 | `_engine_multipath.ts` | `_run_multipath` + 降级单径（ENG2-1/2/3 接线） |
| 12 | `_engine_execute_helpers.ts` | `_run_node_attempts`（重试/脱敏/挂起态构造） |
| 13 | `_engine_loop_front.ts` | 单迭代前半段：护栏/预装配/执行/保留键提取（`__spawn__`/`__plan__`/`__simulate__`/`__multipath__`）/合并/终止信号 |
| 14 | `_engine_loop_back.ts` | 单迭代后半段：三类展开 → checkpoint → 计划推进/边出口定位 |
| 15 叶 | `_engine_execute.ts` | `Engine`（构造挂载子图占位）+ `_execute`：恢复解析/起点定位/`LoopState`/循环收敛/审批卡事件/终态快照/`RunResult` |
| 横向 | `run_subgraph.ts`、`_node_context.ts`、`_loop_types.ts`、`_internals.ts` | 嵌套子图通道与 agent 作用域；节点上下文协议实现；循环局部状态；并发原语/确定性 seam/定位纯函数 |
| 面 | `index.ts`、`contract.ts` | 汇出口与机制契约 |

## 对外契约面

- 公共面逐名核对（`src/index.ts:111-112`）：值 `Engine`、`run_subgraph`；类型 `EngineBase`、`ExecuteOptions`、`NodeContext`。目录 `index.ts` 另导出 `run_agent_scope`/`_validate_subgraph_schema_inheritance`/`_NodeContextImpl`/`_select_next_node`/`_locate_next`（仓内可达，如测试直用 `_NodeContextImpl`），不在公共面。
- 机制契约：`executor_contract = { id: 'executor', contract: { effects: [PORT_STORAGE_SEAM='storage_seam'] }, depends: ['budget','interrupt','llm','multipath','recovery','settle','simulation','spawn'] }`；`llm_port`/`exec_envelope`/`rounds.port` 不列（`path_assembler` 不列项已随机制退役，W7-B；contract.ts 头注逐项说明理由）。

## 数据形态

- 循环状态 `LoopState`：current/current_state/last_checkpoint/active_plan/interrupt_state/reason/error_msg/work_step_signal/parent_id/fork_write/events_before/skip_first_node/plan_pending/四类展开解析产物/thread_id/chain_thread/first_timeline_emit。
- 内部传输形态：`_PlanAdvance`（计划游标推进结果）/`_PlanWorkOutcome`（工作步 overlay 与 interrupt/terminate/error 信号互斥）/`NodeAttemptOutcome`/`WriteCheckpointOptions`/`MultipathData`/`_TraceCarrier`。
- 协议常量：`TerminateReason`（reply/stop/budget_exceeded/error/interrupted）；checkpoint 的 `plan_step`/`work_step` 标记（ENG2-13/恢复判据）；`_INPUT_ASSEMBLY_EVENT_MAX_SOURCES=16`/`_INPUT_ASSEMBLY_EVENT_MAX_TITLE_CHARS=120`；事件日志降频窗 5000ms。
- 状态合并：`_merge_overlay`（schema reducer 或裸覆盖）；恢复判据 `_plan_snapshot_is_work_step`/`_node_in_plan_steps`/`_resume_path_key`。

## Seam 与 IO 边界

- effects 声明 storage_seam：checkpoint/事件日志仅经注入的 `RunOptions.storage` 落库（0-IO：不自持 IO）；并发写保护在存储层链尾乐观锁。
- 确定性 seam：`_set_clock`（epoch 秒/毫秒单调戳）、`_default_id`（进程内单调 id）；日志留痕 `_set_log_sinks`（缺省静默，观察面）。
- 组装上下文窄面 `RunOptions.multipath_assembly`（证据 store/审计 sink/缓存回馈，装配期注入，null = 零证据零审计）；节点标签、装配源、评估器、mixer、预算、沉淀钩子均为宿主注入。

## 装配与消费

- 值面装配：`kernel/runtime/_runtime_engine.ts` 值 import `Engine`/`RunOptions`（运行时装配）、`core/execution_runtime/engine_turn_runner.ts` 值 import `Engine`（主线回合引擎，W7-B 后回合主路径）；`kernel/registry/contracts.ts:22` 收入 31 项全量契约清单（原 `path_assembler`/`pool_governance`/`thread_skeleton` 契约与 `canary.ts`/`_runtime_rounds.ts`/`hosts/lib/test/_graphs.ts` 消费已随组装链路退役，W7-B）；hosts 经公共面。
- 展开关系：run_subgraph = 同一 `Engine._execute` 通道的内联子图（digest 缓存、schema 继承检查 ENG2-7、merge 通道入口归零 + delta 回流）；spawn/推演 = 独立 checkpoint 子链实例（`instance_thread_id`/`simulate_thread_id`）；多径 = `MultipathRunner` 支流展开。
- 错误语义要点：嵌套深度/清单超限/回路超限/计划·推演清单非法/预算超限 fail-closed；spawn·并行组部分失败剔除（`error_on_exception` 决定终止或跳过）；子图/实例 ERROR 不静默回流；中断统一提升父图挂起卡；checkpoint 写失败回滚孤立事件后重抛。

## 不变式与门禁

- 机制三键：依赖单向 DAG——depends 8 项均为值面 import 已核实；runtime depends 闭包——canary/宿主复用经公共面，无机制反向值依赖；零自持 IO——effects 仅 storage_seam，事件/checkpoint 全经注入端口。
- gate 规则：21 文件无 `node:*`/第三方/宿主词；`_internals.ts` 带门禁豁免头注（超限集中层，见疑点 1）。
- 版本链不变式（`_write_checkpoint` 单点维护）：event_seq 取内存态锚点、链尾跟随随写随复位、fork 首写跳过链尾校验、失败回滚孤立事件。

## 测试

`test/kernel/executor/` 镜像测试 6 文件（5 `.test.ts` + `helpers.ts`）：

- `executor.test.ts` — 线性/条件边/循环执行、checkpoint 恢复与 StorageError、terminate 语义、异常脱敏/重试/预算/max_cycle 护栏、编辑重放与 event_seq 增量重放、跨实例恢复。
- `executor_plan.test.ts` — plan_step 工作步标记、并行组首信号取消、成员预装配失败归一、旧锚点续流重放去重。
- `executor_loop_edges.test.ts` — kind=loop 回边执行/失控截止/单节点自环。
- `executor_subgraph.test.ts` — graph_path/回流/共享 coordinator 中断/ERROR 上抛/事件计入锚点/additive·merge 通道/digest 缓存/schema 继承拒绝/子图恢复。
- `executor_recovery.test.ts` — 挂起持久化+注入重入、敏感键剥离、注入一次性清理。
- `executor_simulate.test.ts` — 换选失败归约真实分支序号。

## 疑点与不一致

1. `_internals.ts:1` 门禁豁免头注写「超限(391 行)」，文件实际 389 行——头注与实际行数漂移。
2. `_internals._locate_next` docstring 称「两者皆 null = 图定义不完备」，代码在该情形返回 `[STOP, null]`，「两者皆 null」返回形态在代码中不存在；内层 `if (!graph.exits.has(current))` 仅在出口节点带条件边且全不满足时为假。
3. `index.ts` 头注的文件拆分清单遗漏 `_loop_types.ts`、`_engine_loop_front.ts`、`_engine_loop_back.ts` 三文件；「executor.py 3197 行」为 Python 侧行数断言，TS 侧不可核实。
4. （W7-B 已解）曾记「`contract.ts` 头注称依赖单向 path_assembler→executor，但 `_engine_multipath.ts` 自 `../path_assembler/types.js` type import（AssemblyCandidate/AssemblyRequest）」——组装机制与 canary 已退役，候选链路类型迁至 `kernel/multipath/types.ts`，现 type import 路径 `../multipath/types.js`（运行期擦除；`path_assembler` 表述作废）。
5. `_engine_instance._resolve_graph_data` 对「注册表未注入」「子图类型非法」抛裸 `Error`，同目录其它配置错误用 `GraphDefinitionError`——错误类型不一致。
6. `_engine_multipath._run_multipath_degraded_single`（开关关闭的降级单径）向 `MultipathRunner` 传 `MultiPathConfig({enabled:true})`，「不触发多径机制」实际靠 k=1+并发 1 达成，与配置语义存在措辞落差。
7. `_engine_base.ts:22,29` 对 `core/graph/graph.js` 双重 import（值 `Graph` + 别名 `GraphType` 仅类型），同文件两个名字指同一类型。
8. `_engine_spawn` 与 `_engine_simulate` 均以 `simulate_max_branch_steps` 作为 spawn 实例/分支步数上限（ENG2-8「同口径」），spawn 侧复用推演命名选项——语义复用未见独立命名说明（文件头注有注明同口径，记录备查）。
