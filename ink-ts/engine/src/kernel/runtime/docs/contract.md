# kernel/runtime — 引擎装配/生命周期机壳（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

runtime = 引擎装配/生命周期壳：宿主按 Host 五件套（存储工厂/模型解析/审批策略/事件传输工厂/关停钩子）与
AssemblyRecipe 装配数据把引擎交予运行时，boot/pause/resume/stop 驱动生命周期；每轮回合按数据组装出本轮图再新建引擎执行。
runtime 处于编排位——逐一注入其余机制的装配产物，自身是装配动作的属主而不被机制注入（装配动作归机制层，不可被补丁链改写）。
引擎无常驻静态 Engine。`Runtime` = 13 级抽象基座（`RuntimeBase`→state→runs→specs→ui→contexts→mechanisms→engine→
self_learning→node_registry→assemble→skeleton→rounds）+ 叶类 `Runtime`。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `contract.ts` | 机制契约声明 `runtime_contract`（机制注册表登记项） |
| `index.ts` | 公开面收敛者（镜像 Python `runtime.py` `__all__`） |
| `runtime.ts` | 叶类 `Runtime`：`ledger()`、`round_steps()` |
| `_types.ts` | 数据契约：`Host`/`RuntimeState`/`RunTicket`/`RuntimeConfigInit`/`ToolWiring`/`AssemblyRecipe(+Init)`/`AssemblySourceProvider` |
| `_constants.ts` | 常驻必带集/机制工具/TTL/records 通道键/UI 禁停集常量 |
| `_runtime_base.ts` | `RuntimeBase` 字段基座 + 确定性 seam（`set_runtime_clock`/`_time_now`/`_uuid_hex`/12 位 hex 键源） |
| `_runtime_state.ts` | `RuntimeStateMachine`：boot/pause/resume/stop + `_boot_cleanup` |
| `_runtime_runs.ts` | `RuntimeRunControl`：run 登记/`abort_current_run`/决议留痕/调参辅助 |
| `_runtime_specs.ts` | `RuntimeSpecs`：工具单源+标签、常驻必带集/thread 标签持久化与恢复 |
| `_runtime_ui.ts` | `RuntimeUiComponents`：出厂界面组件启停白名单 |
| `_runtime_contexts.ts` | `RuntimeContexts`：`_self_context`/端点探活/工具索引/装配源提供者 |
| `_runtime_mechanisms.ts` | `RuntimeMechanisms`：证据/缓存/组装运行期/环境/多域装配段 |
| `_runtime_engine.ts` | `RuntimeRebuild`：LLM 链刷新/`_build_graph_engine`/`_restore_set_state` |
| `_runtime_self_learning.ts` | `RuntimeSelfLearning`：自学习族装配 + `evolve_offline` |
| `_runtime_node_registry.ts` | `RuntimeNodeRegistrar`：声明式结点类型注册表面 |
| `_runtime_assemble.ts` | `RuntimeAssemble`：`_assemble` 装配步骤 ①–⑰ |
| `_runtime_skeleton.ts` | `RuntimeSkeleton`：会话骨架 + 续跑意图协议（P4） |
| `_runtime_rounds.ts` | `RuntimeRounds`：`assemble_round`/`resume_round`/`resume_run` |
| `_round_steps_recorder.ts` | `_RoundStepsRecorder`：回合步骤记录器（EngineTransport） |
| `_settle.ts` | `_KnowledgeUsageSettleHook`/`_LedgerSettleHook` 归因与账本钩子 |

## 对外契约面

- 机制契约 `runtime_contract`：effects=[`storage_seam`, `llm_port`]；depends=22 项（approval/audit_log/entity_evolution/evolution/evolution_writer/executor/growth/introspection/llm/memory_extract/path_assembler/permissions/pool_governance/self_application/self_proposal/self_tools/settle/skill_crystal/thread_skeleton/tool_pipeline/tool_vetting/tuning）。`exec_envelope` 不列（不直接消费进程/沙箱 seam）；`rounds.port` 不列——回合入口由 runtime 自身实现，属提供方而非消费者。
- 公共面（`src/index.ts`「运行时装配」组，逐名核对）：值导出 `AssemblyRecipe`/`Runtime`/`RuntimeState`/`RunTicket`/`set_runtime_clock`/`ROUND_CONTINUATION_STATE_KEY`；类型导出 `AssemblyRecipeInit`/`AssemblySourceProvider`/`EvolveOfflineOptions`/`EvolveOfflineResult`/`Host`/`RunTaskHandle`/`RuntimeConfigInit`/`ToolWiring`/`ContinuationIntent`/`ContinuationReason`；`THREAD_SKELETON_STATE_KEY`/`ThreadSkeleton` 等 5 名真源在 `core/thread_skeleton`（公共面直取 core，runtime index 亦转口）。
- 目录 `index.ts` 导出、公共面未导出（内部面）：`parse_continuation_state`/`ROUND_GRAPH_STATE_KEY`/`RECENT_TOPS_STATE_KEY`/`RoundAssembleOptions`/`_KnowledgeUsageSettleHook`；`_` 前缀文件不随公共面外泄。

## 数据形态

- 生命周期：`RuntimeState` = uninitialized/running/paused/stopped；非法转换显式报错，boot/stop 幂等。
- 装配：`AssemblyRecipe` 字段见 `_types.ts`（机制开关缺省全开；thread_skeleton_enabled/auto_continue_limit/candidate_trial_enabled/anti_monopoly_enabled/seed_edges_enabled 缺省关闭/0）。
- state 保留键（checkpoint state 通道，互不冲突）：`_round_graph`（本轮图定义）、`_recent_tops`（反垄断窗口）、`_round_continuation`（续跑意图）、`_thread_skeleton`（会话骨架，真源 `core/thread_skeleton/types.ts`）。
- records 通道：`runtime_config` × 键 `tool_baseline`/`tool_thread_tags`/`ui_components_disabled`；`ledger`（回合账本，schema=`round_ledger/1`，键 = `thread<US>回合序号`）。
- 常量：`BASELINE_TOOL_NAMES`（11 件）、`BASELINE_IMMUTABLE_TOOLS`（2 件）、`TAG_IMMUTABLE`/`TAG_BASELINE`、`THREAD_TAG_TTL_SECONDS`=259200、`UI_COMPONENTS_PROTECTED`（4 件）、`_ASSEMBLY_SOURCE_LIMIT`=8、`DEFAULT_STEP_LIMIT`=50、`_MEMORY_RECALL_LIMIT`=5、`_MEMORY_RECALL_CHARS`=400、`_SKILL_PRIOR_LIMIT`=4、`_SKILL_PRIOR_FALLBACK_LIMIT`=2、`_CANDIDATE_EVENT_LIMIT`=8、`_ROUND_TOP_K_DEFAULT`=8、`_TUNED_TOP_K_MAX`=64、注入集预算上限 18、`ENV_INSTALL_KEY_PREFIX`=`env.install`。

## Seam 与 IO 边界

- 自身消费两端口（契约 effects）：`storage_seam`——`_runtime_assemble` 经 `host.create_storage()` 取原始存储后包 `GuardedStorage`；`llm_port`——`_runtime_engine` 经 `host.resolve_llm()` 取 AsyncLLM 并包 `UsageTrackingLLM`/`CompressingLLM` 守卫链。
- 宿主 seam：`Host` 五件套注入点；`mcp_manager`（未注入=不启用）；`RunTaskHandle` 任务取消句柄；`scope_model_llm` 作用域模型解析接线位（缺省 null=未接线显式失败）；`ToolWiring` 三路自指工具声明。
- 确定性 seam：`set_runtime_clock` 时钟冻结面；`RuntimeConfigInit` now/audit_key_gen/growth_uuid_gen 实例级键源；在途凭证 id 自增 32 位十六进制。
- 机制层零自持 IO：无 node:* import（verify_mechanisms 0-IO 键覆盖本目录）。

## 装配与消费

- 装配：`boot()` → `_assemble` 步骤 ①–⑰（首步 `seal_mechanism_registry` fail-closed；存储→GuardedStorage→注册表/种子/管线/harness/事件类型/实体/校验器/自指管线/界面/元工具/检索源/统一流水线/集状态恢复/常驻集/工具索引/apply 目标/调参/池治理/引擎重建）；装配失败 `_boot_cleanup` 回收后原样上抛。
- 回合：`assemble_round`（input/域 → AssemblyRequest → 组装候选 → 评分顶选 → `_build_graph_engine` → ainvoke）；`resume_round`/`resume_run` 按 checkpoint 关联图重建（digest 不一致显式报错拒绝续跑）；`abort_current_run` 写 CANCELLED 快照。错误语义：非 running 拒新 run、组装运行期未挂载与组装无候选显式报错。
- 下游：`src/index.ts` 公共面 → `hosts/lib`（host/recipe/boot/bridge 等取 `Runtime`/`Host`/`AssemblyRecipeInit` 等）、`hosts/cli`（engine_attach 取 `Runtime`）；`kernel/registry/contracts.ts` 与 `scripts/verify_mechanisms.ts` 取 `runtime_contract`。静态消费皆经公共面，hosts 无路径直连。

## 不变式与门禁

- 机制三键适用性：依赖单向 DAG——`runtime_contract.depends` 22 项均须在 `ALL_MECHANISM_CONTRACTS` 中（contracts_registry.test 强制）；runtime depends 闭包 ∪ 自足叶子 = 全量机制（verify_mechanisms 装配完整键）；机制层零自持 IO。装配动作不可被补丁链改写（自指终止）；boot 首步密封 fail-closed。
- gate 规则：单文件 ≤350 行、禁宿主词、kernel 禁反向依赖 adapters；本目录 6 份文件带「gate: 超限」豁免头注（行数核对见「疑点与不一致」）。

## 疑点与不一致

以下为通读逐条核实的事实，不推测动机；「未见显式说明」= 源码内无解释：

- gate 超限头注所记行数与实际不符（头注/实测）：`_types` 356/369、`_runtime_engine` 390/384、`_runtime_mechanisms` 351/552、`_runtime_assemble` 371/401、`_runtime_skeleton` 420/226、`_runtime_rounds` 390/598；`_runtime_skeleton` 实测低于 350 上限仍带超限头注。
- `_runtime_state.ts` 头注的 stop 顺序（MCP→存储→宿主钩子）漏列 `stop()` 实际执行的「关 LLM 链」环节（`stop()` 方法注释有列）。
- `_runtime_runs.ts` `abort_current_run` 头注「自取消显式报错」：实现无任何抛错路径（无 run/无句柄/已完成/无 then 四种情形均返回 false）。
- `_runtime_specs.ts` `tag_tool` 头注「工具不存在时静默忽略」：实现对未注册工具放行 `TAG_IMMUTABLE` 标签（`&& tag !== TAG_IMMUTABLE` 例外未见于头注）。
- `_runtime_assemble.ts` harness 开局落库去重：两次 `to_dict()` 结果做 `===`（引用相等）；`HarnessDefinition.to_dict` 每次构造新对象（core/harness/definition.ts）——`same` 恒 false，「相同定义跳过」分支按现实现不可达。
- `_runtime_assemble.ts` 注释「（见第 2 节）」指向的章节不存在；头注「步骤 ①–⑰」与同句列举的 20 个段名数目不符。
- `_runtime_rounds.ts` `assemble_round` 声明的局部 `thread_id` 函数体内未使用。
- 孤儿面（全仓 grep 无消费方）：`_runtime_engine._pool_governance_audit`（与 `_mechanism_audit_record` 重复实现 emit_audit 包装）、`_runtime_node_registry.archive_node_type`（disable 有测试消费）、`_runtime_specs.baseline_factory_names`、`_types.RunTicket`（doc 称「begin_run 发放」而 `begin_run` 实际返回普通对象 `{ id }`）、`_types.AssemblySourceProvider`（单数；实际消费 core 复数 `AssemblySourcesProvider`）、`_runtime_base` 尾部转出的 `TAG_IMMUTABLE`、`ENV_INSTALL_KEY_PREFIX`（导出仅本文件消费）。
- 命名/常量分散：键分隔符 `'\u001f'` 在 `_runtime_specs` 与 `_settle` 各定义 `_KEY_SEP`；注入集预算上限 18 两处硬编码（collect_specs 兜底与 `_runtime_assemble` 的 ToolSelector max_tools）；审批键前缀 `env.install` 与 action.tool `environment.install` 并存；`AssemblyCtx` 与 round_steps 同名接口异型。
- 落库通道不一：ledger 走 `storage.put_record` 直写，baseline/thread 标签/UI 停用集走 EvolutionWriter（`runtime_config_writer`）管线——取舍未见显式说明；`_runtime_ui` 落盘经动态 `await import` 装载 evolution_writer（src 内仅两处动态 import 之一），`_runtime_specs` 同依赖为静态 import。
- `_runtime_engine.ts` `_restore_diag` 注释「写入只经 _restore_set_state」与 `_runtime_node_registry._assemble_node_registry` 直接追加写入并存。
- `_settle.ts` `_LedgerRuntime._round_review_events` 注释「不在此消费」：`_LedgerSettleHook.settle` 随即读取该字段并入账本事实；同文件对 `step.status` 一处用 `'failed'` 字面量、一处用 `TRACE_FAILED` 常量。
- 类型面与消费面经断言补齐（普遍模式，未见集中说明）：`IntrospectionService._sources`、`KnowledgeSet.on_mutation`、`Engine._publish`、`mcp_manager.list_servers`（字段声明仅 close_all）、`_active_run_task.then === undefined`（按声明类型不可达的防御分支）、多处 `as never`。
- 轻微口径差：`resume_run` 返回 `Promise<unknown>`（同层两入口返回 RunResult）；`_round_request` 对 divergence_width 有 Number.isFinite 保护而 `_record_round_tuning`/`assembly_round_retries` 无；`_stamp_recent_tops` 注释「state 通道不增空槽」与 `_round_continuation` 落键置 null 并存。

## 测试

`test/kernel/runtime/` 镜像测试（16 文件）：`runtime.test.ts`（boot 幂等/状态机/stop 排空/决议重入/工具标签/账本/键源）、`runtime_rounds.test.ts`（组装回合端到端）、`runtime_rounds_approval.test.ts`（审批挂卡与 resume）、`runtime_rounds_cap.test.ts`（max_tool_rounds 接线）、`runtime_mechanisms.test.ts`（证据/缓存/环境/运行期挂载）、`runtime_auto_continue.test.ts`（自续跑护栏）、`runtime_session_skeleton.test.ts`/`runtime_skeleton_seed.test.ts`（会话骨架）、`runtime_recent_tops_persist.test.ts`（反垄断窗口持久化）、`runtime_round_steps_recorder.test.ts`（记录器）、`self_learning.test.ts`（记忆抽取/结晶/调参/evolve_offline）、`runtime_feedback_loop.test.ts`（回灌闭环）、`runtime_field_chain.test.ts`（字段链/seed_edges）、`runtime_skill_fallback.test.ts`（技能 general 回落）、`pool_governance_wiring.test.ts`（治理写回 seam）、`_round_graphs.ts`（数据图 helper）。
