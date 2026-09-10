# runtime/（kernel/runtime）

引擎装配/生命周期机壳：宿主按 Host 五件套与 AssemblyRecipe 装配数据把引擎交予
Runtime，boot/pause/resume/stop 驱动生命周期，每轮回合按数据组装出本轮图再新建
引擎执行（runtime.py 移植；`Runtime` 类 = 分层链叶类）。

## 文件
- `contract.ts` — 机制契约声明：`runtime_contract`（effects=[storage_seam, llm_port]，depends=22 机制件）。
- `index.ts` — 公开面收敛者（镜像 Python `runtime.py` `__all__`；含转口 `core/thread_skeleton` 一组）。
- `runtime.ts` — 叶类 `Runtime`：`ledger()`（线程最近回合账本）+ `round_steps()`（回合步骤查询）。
- `_types.ts` — 数据契约：`Host` 五件套、`RuntimeState`、`RunTicket`、`RuntimeConfigInit`、`ToolWiring`、`AssemblyRecipe`/`AssemblyRecipeInit`。
- `_constants.ts` — 机壳常量：常驻必带集 `BASELINE_TOOL_NAMES`、`BASELINE_IMMUTABLE_TOOLS`、thread 标签 TTL、records 通道键、UI 禁停集 `UI_COMPONENTS_PROTECTED`。
- `_runtime_base.ts` — `RuntimeBase` 字段基座：实例级确定性 seam（时钟/审计键/成长 id/凭证 id）+ 全部装配产物字段与只读观察面。
- `_runtime_state.ts` — `RuntimeStateMachine`：boot（幂等）/pause/resume/stop 状态机 + 装配失败清理 `_boot_cleanup`。
- `_runtime_runs.ts` — `RuntimeRunControl`：在途 run 登记（begin_run/end_run）、`abort_current_run`（CANCELLED 快照）、决议事件留痕、收尾调参辅助。
- `_runtime_specs.ts` — `RuntimeSpecs`：单源+标签工具表（merged_specs/collect_specs/tag_tool）、常驻必带集与 thread 标签的持久化/恢复。
- `_runtime_ui.ts` — `RuntimeUiComponents`：出厂界面组件启停白名单（禁停集 fail-closed + records 通道持久化）。
- `_runtime_contexts.ts` — `RuntimeContexts`：自指工具上下文 `_self_context`、端点探活、工具索引刷新、装配源提供者（检索/知识/记忆回灌）。
- `_runtime_mechanisms.ts` — `RuntimeMechanisms`：机制装配段——边证据/指纹缓存/组装运行期挂载/环境 install/沉淀钩子链/多域调配器。
- `_runtime_engine.ts` — `RuntimeRebuild`：LLM 守卫链刷新 `rebuild_engine` + `_build_graph_engine` 按图建本轮引擎 + 集状态恢复 `_restore_set_state`。
- `_runtime_self_learning.ts` — `RuntimeSelfLearning`：记忆抽取/技能结晶/收尾调参装配 + `evolve_offline` 离线进化入口。
- `_runtime_node_registry.ts` — `RuntimeNodeRegistrar`：声明式结点类型注册表面（boot 种子/重启恢复/register/disable/archive）。
- `_runtime_assemble.ts` — `RuntimeAssemble`：`_assemble` 装配步骤 ①–⑰（首步 `seal_mechanism_registry` 密封）。
- `_runtime_skeleton.ts` — `RuntimeSkeleton`：会话级骨架加载/校验/显式种子/续跑意图协议（P4）。
- `_runtime_rounds.ts` — `RuntimeRounds`：run 级组装回合入口 `assemble_round`/`resume_round`/`resume_run`（A2：无默认图）。
- `_round_steps_recorder.ts` — `_RoundStepsRecorder`：EngineTransport 协议的回合步骤内存记录器（有界、线程隔离）。
- `_settle.ts` — 知识使用归因钩子 `_KnowledgeUsageSettleHook` + 回合账本钩子 `_LedgerSettleHook`（引擎自接线）。

## 依赖
- 上游（本目录实际 import）：`core/`（assembly、context、events、graph、json、schema、ledger、harness、entities、event_types、knowledge_set、nodes、declarative_tools、storage、registry 类型、retrieval、run_result、ui_schema、thread_skeleton、seeds、edge_evidence、fingerprint_cache、memory、node_registry、tool_index、tool_orchestrator、contracts、environments、errors、perception）；`kernel/` 机制件（approval、audit_log、evolution、evolution_writer、executor、growth、entity_evolution、introspection、llm、memory_extract、path_assembler、permissions、pool_governance、self_application、self_proposal、self_tools、settle、skill_crystal、tool_pipeline、tool_vetting、tuning）；`kernel/registry`（contract_types/ports/index）；`kernel/round_steps`（仅 type import，不入 depends）。
- 下游（实际 import 本目录）：`src/index.ts`（公共面「运行时装配」组）；`kernel/registry/contracts.ts`（`runtime_contract` 入全量契约清单）；`engine/scripts/verify_mechanisms.ts`（runtime_contract）；测试 `test/kernel/runtime/`（16 文件）、`test/e2e/`（_e2e_fixtures、runtime_e2e）、`test/core/nodes/nodes_cold_start.test.ts`、`test/kernel/registry/contracts_registry.test.ts`；宿主 `hosts/lib`、`hosts/cli` 经 `@ink-ts/engine` 公共面（非路径直连）。
