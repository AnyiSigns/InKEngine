# runtime/（kernel/runtime）

引擎装配/生命周期机壳：宿主按 Host 五件套与 AssemblyRecipe 装配数据把引擎交予
Runtime，boot/pause/resume/stop 驱动生命周期（runtime.py 移植；`Runtime` 类 =
分层链叶类）。W7-B 注：「每轮回合按数据组装本轮图再新建引擎执行」的组装回合
入口（`_runtime_rounds`/`_runtime_skeleton`）已退役——主线回合 = 执行运行时
（rounds.send → `core/execution_runtime/engine_turn_runner` 按作用域建图）。

## 文件
- `contract.ts` — 机制契约声明：`runtime_contract`（effects=[storage_seam, llm_port]，depends=19 机制件）。
- `index.ts` — 公开面收敛者（镜像 Python `runtime.py` `__all__`；W7-B 后无骨架/续跑意图转口）。
- `runtime.ts` — 叶类 `Runtime`：`ledger()`（线程最近回合账本）+ `round_steps()`（回合步骤查询）。
- `_types.ts` — 数据契约：`Host` 五件套、`RuntimeState`、`RunTicket`、`RuntimeConfigInit`、`ToolWiring`、`AssemblyRecipe`/`AssemblyRecipeInit`。
- `_constants.ts` — 机壳常量：常驻必带集 `BASELINE_TOOL_NAMES`、`BASELINE_IMMUTABLE_TOOLS`、thread 标签 TTL、records 通道键、UI 禁停集 `UI_COMPONENTS_PROTECTED`。
- `_runtime_base.ts` — `RuntimeBase` 字段基座：实例级确定性 seam（时钟/审计键/成长 id/凭证 id）+ 全部装配产物字段与只读观察面。
- `_runtime_state.ts` — `RuntimeStateMachine`：boot（幂等）/pause/resume/stop 状态机 + 装配失败清理 `_boot_cleanup`。
- `_runtime_runs.ts` — `RuntimeRunControl`：在途 run 登记（begin_run/end_run）、`abort_current_run`（CANCELLED 快照）、决议事件留痕 seam、回合收尾调参入口 `tune_after_round`。
- `_runtime_specs.ts` — `RuntimeSpecs`：单源+标签工具表（merged_specs/collect_specs/tag_tool）、常驻必带集与 thread 标签的持久化/恢复。
- `_runtime_ui.ts` — `RuntimeUiComponents`：出厂界面组件启停白名单（禁停集 fail-closed + records 通道持久化）。
- `_runtime_contexts.ts` — `RuntimeContexts`：自指工具上下文 `_self_context`、端点探活、工具索引刷新、装配源提供者（检索/知识/记忆回灌）。
- `_runtime_mechanisms.ts` — `RuntimeMechanisms`：机制装配段——边证据存储/环境提供器登记与 install 入口/沉淀钩子链装配（指纹缓存与组装运行期挂载段已随 W7-B 退役）。
- `_runtime_engine.ts` — `RuntimeRebuild`：LLM 守卫链刷新 `rebuild_engine`（引擎无常驻静态 Engine）+ 集状态恢复 `_restore_set_state`。
- `_runtime_self_learning.ts` — `RuntimeSelfLearning`：记忆抽取/技能结晶容器/收尾调参装配 + `evolve_offline` 离线进化入口。
- `_runtime_node_registry.ts` — `RuntimeNodeRegistrar`：声明式结点类型注册表面（boot 种子/重启恢复/register/disable/archive）。
- `_runtime_boot.ts` — `RuntimeBoot`：`_assemble` 装配步骤 ①–⑰（首步 `seal_mechanism_registry` 密封；原 `_runtime_assemble` 并入本文件，W7-B）。
- `_round_steps_recorder.ts` — `_RoundStepsRecorder`：EngineTransport 协议的回合步骤内存记录器（有界、线程隔离）。
- `_settle.ts` — 知识使用归因钩子 `_KnowledgeUsageSettleHook` + 回合账本钩子 `_LedgerSettleHook`（引擎自接线）。
（`_runtime_skeleton.ts`/`_runtime_rounds.ts` 已随 W7-B 组装链路退役删除。）

## 依赖
- 上游（本目录实际 import）：`core/`（context、events、graph、json、schema、ledger、harness、entities、event_types、knowledge_set、nodes、declarative_tools、storage、registry 类型、retrieval、run_result、ui_schema、seeds、edge_evidence、memory、node_registry、tool_index、tool_orchestrator、contracts、environments、errors、perception；`assembly`/`thread_skeleton`/`fingerprint_cache` 已随 W7-B 退役删除）；`kernel/` 机制件（approval、audit_log、evolution、evolution_writer、executor、growth、entity_evolution、introspection、llm、memory_extract、permissions、self_application、self_proposal、self_tools、settle、skill_crystal、tool_pipeline、tool_vetting、tuning；`path_assembler`/`pool_governance` 已随 W7-B 退役删除）；`kernel/registry`（contract_types/ports/index）；`kernel/round_steps`（仅 type import，不入 depends）。
- 下游（实际 import 本目录）：`src/index.ts`（公共面「运行时装配」组）；`kernel/registry/contracts.ts`（`runtime_contract` 入全量契约清单）；`engine/scripts/verify_mechanisms.ts`（runtime_contract）；测试 `test/kernel/runtime/`（4 文件）、`test/e2e/_e2e_fixtures.ts`（`runtime_e2e.test.ts` 随组装回退 flag 退役删除，W7-B）、`test/core/nodes/nodes_cold_start.test.ts`、`test/kernel/registry/contracts_registry.test.ts`；宿主 `hosts/lib`、`hosts/cli` 经 `@ink-ts/engine` 公共面（非路径直连）。
