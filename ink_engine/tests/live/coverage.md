# live 套件覆盖基线（契约清单）

> 基线来源：`docs/api.md` 契约清单 + 各模块 docstring 承诺。
> 用途：59 模块逐项打勾，**孤儿模块 = 失败**（模块在清单中但无对应用例）。
> 维护：新增/修改 live 用例时同步更新「用例映射」列；全量运行后由
> `report.py` 按映射表自动核对并输出覆盖矩阵。
>
> 口径：`llm/` 计 1 个模块（8 个子模块在括号内列出）；共 59 个模块
> （58 个 core 模块 + llm 包）。

## 映射表

| # | 模块 | 契约行为（基线） | 用例映射（文件::测试） | 状态 |
|---|------|------------------|------------------------|------|
| 1 | core/executor | Engine.run/ainvoke、RunOptions、checkpoint/resume/continue_chain、inject、update_state、swap_branch、decision_anchor、error_on_exception、max_node_retries、保留键 __plan__/__spawn__/__simulate__ | test_01_execution::* | ☑ |
| 2 | core/budget | BudgetManager.register/check、BudgetPolicy 协议、BudgetExceededError fail-closed | test_01_execution::* | ☑ |
| 3 | core/fanout | fan_out(tasks, limit, propagate) 并发发散/部分失败剔除 | test_01_execution::* | ☑ |
| 4 | core/plan | 计划约束域 loose/strict、max_plan_steps、越界拒绝 | test_01_execution::* | ☑ |
| 5 | core/spawn | __spawn__ 子任务展开/独立子链/收集/护栏 max_spawns/spawn_concurrency | test_01_execution::* | ☑ |
| 6 | core/simulation | __simulate__ 推演/打分择优/轨迹树引用/落选分支保留/evaluator/branch_mixer | test_01_execution::* | ☑ |
| 7 | core/recovery | 恢复锚点收集/状态通道继承/重放纪律/断链续流 | test_01_execution::* | ☑ |
| 8 | core/interrupt | 挂起/注入/重入/持久化（随 checkpoint 落库） | test_01_execution::* | ☑ |
| 9 | core/state | StateSchema 通道 reducer 契约/add_messages/merge_dicts/merge_metrics/last_value/register_reducer | test_02_state_patch::* | ☑ |
| 10 | core/patch_chain | PatchChain append/assemble(full/base_only/partial)/rebase/truncate/branch、Patch 三 kind | test_02_state_patch::* | ☑ |
| 11 | core/state_machine | StateMachine append/rollback/非法转换拒绝/领域状态名 | test_02_state_patch::* | ☑ |
| 12 | core/storage | Storage 三通道协议（checkpoint/事件/records）、create_storage、敏感键剥离、乐观锁、close | test_03_storage::* | ☑ |
| 13 | core/storage_memory | memory:// 全通道语义 | test_03_storage::* | ☑ |
| 14 | core/storage_sqlite | sqlite:// 全通道 + 跨进程读取 + schema 自检 | test_03_storage::* | ☑ |
| 15 | core/storage_postgres | postgresql://（无环境跳过，协议由单测覆盖） | test_03_storage::* | ☑ |
| 16 | core/chain_rebase | 链级 rebase（plan_compaction/窗口压缩/链头改写）、CheckpointConflictError | test_03_storage::* | ☑ |
| 17 | core/events | EngineEvent 全字段/trace_id/seq/CollectorTransport/JSON Lines/to_dict/from_dict/to_json | test_04_events::* | ☑ |
| 18 | core/event_types | EventTypeSpec/EventTypeRegistry.register/classify 宽松折叠/system 事件/协议版本校验 | test_04_events::* | ☑ |
| 19 | core/round_steps | RoundSteps 回合步骤累积（user/reply_token/review_card/tool_*/node_*/plan_*/error）step_id 稳定 | test_04_events::* | ☑ |
| 20 | core/logging | configure_engine_logging 幂等/trace_id 贯穿/redact 凭据 | test_04_events::* | ☑ |
| 21 | llm（base/registry/openai_compat/fallback/errors/messages/tools/embeddings） | AsyncLLM 协议/ainvoke/astream/aclose、create_llm/register_adapter、SSE 解析/reasoning 透传、ModelChain 重试与认证 fail-closed、classify_llm_error、Message/ToolCall 工厂、ToolSpec/to_openai_tools、AsyncEmbedder | test_05_llm_full::* | ☑ |
| 22 | core/knowledge_signals | 五类信号分类（踩坑/用户修正/洞见/流程缺口/重复根因） | test_06_self_learning::* | ☑ |
| 23 | core/evolution | 蒸馏器协议（确定性+LLM）、精准补丁 replace 语义、失败率优先入队、反思式变异、防退化拒绝 | test_06_self_learning::* | ☑ |
| 24 | core/knowledge_gate | 三层验证闸门 L1/L2/L3、scan_text_injection、样例库 FixtureSet/FixtureCase/assert_fixtures_pass | test_06_self_learning::* | ☑ |
| 25 | core/rules | RuleSet.parse 全 kind/RuleTypeRegistry/内置谓词/未知谓词建期拒绝/target_path 私有段 | test_06_self_learning::* | ☑ |
| 26 | core/schema_validator | SchemaSpec/SchemaField/SchemaValidator.validate 逐字段校验 | test_06_self_learning::* | ☑ |
| 27 | core/scoring | WeightedScorer/ScoringConfig 维度+权重+阈值/overall 判定 | test_06_self_learning::* | ☑ |
| 28 | core/review | Reviewer/Regenerator/WebVerifier 协议、MaxRoundsConvergencePolicy 收敛/超限呈交 | test_06_self_learning::* | ☑ |
| 29 | core/assembly | AssemblyConfig/InputAssembler/ContextSource/常量/activate 留痕/多源调配 | test_07_assembly::* | ☑ |
| 30 | core/context | ContextMixer/ContextAssembler/WeightedBudgetAllocator/CompressionPolicy/融合钩子回退/域窗口 | test_07_assembly::* | ☑ |
| 31 | core/approval | approve_before_execute/approve_batch/DefaultInterruptPolicy/InterruptPolicy/决议全集/超时与非法注入 reject | test_08_approval::* | ☑ |
| 32 | core/review_card | 四类卡（gate/body/audit/candidate）数据模型/门控分级注册表 gating_tier_of | test_08_approval::* | ☑ |
| 33 | core/tool_pipeline | ToolPipeline 全环节（门禁/沙箱/守卫/执行/审计/截断）、ToolResult、allow_unchecked | test_09_tools_security::* | ☑ |
| 34 | core/permissions | PermissionGate 三路/parse_permission/NetworkPolicy/通配越界拒绝 | test_09_tools_security::* | ☑ |
| 35 | core/sandbox | FileSandbox（真实读写+快照还原）/ProcessSandbox（白名单+超时 kill+输出截断+env 清理） | test_09_tools_security::* | ☑ |
| 36 | core/declarative_tools | DeclarativeToolSpec 四端点/endpoint_operation/注册表/自动接线沙箱 | test_09_tools_security::* | ☑ |
| 37 | core/tool_orchestrator | 工具调配评分/去重/预算/ToolTraceStore append-only | test_09_tools_security::* | ☑ |
| 38 | core/tool_vetting | vet(manifest, code_paths)/shadow_run/ToolManifest/静态钩子 | test_09_tools_security::* | ☑ |
| 39 | core/builder | 白名单构建命令/产物内容寻址哈希/冒烟门禁（cwd 限定） | test_09_tools_security::* | ☑ |
| 40 | core/environments | local 提供器安装/运行/env_audit 补丁链留痕/环境=数据 round-trip | test_09_tools_security::* | ☑ |
| 41 | core/introspection | inspect_* 五工具（恒定信封/降级视图/敏感剥离） | test_10_self_evolution::* | ☑ |
| 42 | core/self_tools | 4 契约演化工具/SELF_TOOL_CONTRACT/SelfToolContext/operation_of | test_10_self_evolution::* | ☑ |
| 43 | core/self_proposal | SelfProposal 9 类 kind/ProposalValidator 建期拒绝 | test_10_self_evolution::* | ☑ |
| 44 | core/self_application | SelfApplicationPipeline apply/revert/audit_log/GuardedStorage 旁路写拒绝/L0/L1/L2 分级 | test_10_self_evolution::* | ☑ |
| 45 | core/ui_schema | UISpec/UISchemaValidator 三层白名单/UIRenderer 契约/绑定路径前缀防护 | test_10_self_evolution::* | ☑ |
| 46 | core/runtime | Host 五件套/AssemblyRecipe/boot 幂等/生命周期状态机/begin_run/end_run/resume_run/rebuild_engine/stop 排空 | test_11_runtime::* | ☑ |
| 47 | core/seeds | seed_general/build_general_seed_entries/SeedProvider/幂等注入 | test_12_seeds::* | ☑ |
| 48 | seeds/boot | build_boot_seed_entries/BOOT_SYSTEM_PROMPT/BOOT_UI_SPEC/BOOT_EVENT_TYPES/boot_harness_definition/BOOT_METATOOLS | test_12_seeds::* | ☑ |
| 49 | core/graph | Graph 全特性（节点/边/条件边/子图/多出口/编译校验/指纹/序列化拒绝函数直挂） | test_13_graph_full::* | ☑ |
| 50 | core/registry | 节点注册表（type 数据解析/未知类型错误路径） | test_13_graph_full::* | ☑ |
| 51 | core/harness | 声明式定义/注册表路由/补丁链仓库（版本回退）/未注册名拒绝 | test_13_graph_full::* | ☑ |
| 52 | core/memory | StorageBackedMemoryStore/MemoryQuery 全过滤/PriorityRecallPolicy/非破坏性失效 | test_14_memory::* | ☑ |
| 53 | core/workflow | WorkflowSpec/build_workflow_graph/宽松严格序/越界拒绝 | test_15_workflow::* | ☑ |
| 54 | core/knowledge_set | KnowledgeSet 全方法（entries/get/add/update 精准补丁/remove/archive/promote/export/from_export/save/load/search）/seed_knowledge_set 幂等 | test_16_knowledge_full::* | ☑ |
| 55 | core/retrieval | RetrieverRegistry/RetrievedChunk/注入扫描剔除/检索接入调配 | test_16_knowledge_full::* | ☑ |
| 56 | core/tuning | 回合指标聚合/参数快照/降权生效/回放可重算 | test_17_tuning::* | ☑ |
| 57 | core/tiers | tier_key/resolve_tier_config/build_tier_chain/TierCallStats | test_17_tuning::* | ☑ |
| 58 | core/mcp_client | 三传输（stdio/http/in_memory）/工具转换/vetting 过滤/冲突拒绝/未连接 fail-closed/close_all | test_18_mcp_full::* | ☑ |
| 59 | core/security | is_sensitive_key/strip_sensitive 纯函数（落库/出网/日志三出口同规格） | test_19_data_contracts::* | ☑ |

## 全模块数据契约（族 19 基准，覆盖矩阵「数据契约」维度）

以下数据形态须在族 19 各做 round-trip 指纹一致 + 敏感键剥离 + 版本字段检查
（以 `docs/api.md`「其他常用原语」与各模块 docstring 为准）：

Graph / Plan / WorkflowSpec / HarnessDefinition / RuleSet / FixtureSet /
KnowledgeEntry / SchemaSpec / UISpec / EventTypeSpec / DeclarativeToolSpec /
ToolManifest / ContextSource / AssemblyRecipe / EngineEvent / CheckpointRecord /
PatchChain / ToolTrace / MemoryEntry / ApprovalDecision / InterruptState /
Message / ToolCall / LLMConfig / McpServerConfig / VettingResult /
EnvironmentSpec / BuildSpec / Rule

## 门禁核对规则（report.py 实现）

1. 「未覆盖」= 0：上表 59 行逐一有非空用例映射且状态 ☑（孤儿模块 = 失败）
2. 每机制族 ≥1 条真实 LLM 驱动用例（`real` 标记；确定性机制用例不计入）
3. 叠加 S1-S10 全绿（含机制触发探针）
4. 对抗性全按 fail-closed 拒绝
5. 「机制缺陷」类失败 = 0（经确定性复现归类）
