# InkEngine 公开 API 速查

本文档列出宿主与复用者实际要碰的**稳定公开契约**（签名/默认值/一句话
语义），不穷举模块内部。完整行为以模块 docstring 与 `extensions.md`
示例为准；`python -c "from ink_engine.core.xxx import Y; help(Y)"` 可
读任意符号的详细文档。

> 引擎是库，无 HTTP API——HTTP 端点属宿主层（InKling 智能体的
> 桌面壳/CLI），不进本文档。

## 图与执行（core.graph / core.executor）

```python
from ink_engine.core.executor import Engine, RunOptions, RunResult
from ink_engine.core.graph import Graph
from ink_engine.core.storage import create_storage
```

**Graph**：`Graph(name, entry, node_registry=None)`
- `add_node(name, fn)` 函数直挂；`add_node_type(name, type_name, config)` 声明式（需注册表解析）
- `add_edge(source, target)` 静态边；`add_conditional_edge`（函数）/ `add_conditional_edge_by_name`（可序列化）
- `add_subgraph(name, graph)` 嵌套子图；`add_exit(name)` 声明出口（exit 节点 = 正常终止）
- `to_dict()/from_dict(data, registries=...)` 图 = 数据（函数直挂节点序列化显式拒绝）
- `digest()` 图指纹（sha256）；`compile()` 建期校验（入口/边目标/静态边与条件边不混用）

**Engine**：`Engine(graph, *, options: RunOptions)`
- `run(initial, *, thread_id, resume_from=None, continue_chain=False, inject=None)` → `AsyncGenerator[EngineEvent]`
- `ainvoke(...)` → `RunResult`（`reason`/`state`/`checkpoint_id`/`interrupt`/`events_emitted`）
- `update_state(thread_id, values)` 外部补丁；`get_latest_interrupt(thread_id)`
- `swap_branch(...)` 推演回溯换选；`decision_anchor(...)` 决策点锚点反查

**节点约定**：`async (ctx) -> PartialState | None`；`ctx` 为 NodeContext：
`ctx.state`（通道字典）、`ctx.emit(type, payload, step_id=...)`、
`ctx.interrupt(key, payload)`、`ctx.assemble(sources, ...)`、
`ctx.spawn(subgraph, state, ...)`、`ctx.llm`/`ctx.tool_pipeline`/`ctx.tool_specs`。

**RunOptions 关键字段**（默认值）：

| 字段 | 默认 | 语义 |
|---|---|---|
| `storage` | None | 持久化（必配：`create_storage(...)`） |
| `schema` | None | StateSchema（通道 reducer 契约） |
| `budget` | None | BudgetManager（节点边界预算检查） |
| `transports` | [] | 事件传输列表 |
| `max_node_retries` | 0 | 节点失败重试 |
| `error_on_exception` | True | 异常终止（False = 跳过继续） |
| `max_spawns` | 16 / `spawn_concurrency` 4 | 子任务展开护栏 |
| `checkpoint_keep` | 256 | 版本链窗口（0 = 禁用压缩） |
| `system_events` | frozenset() | 系统事件（step_id=None） |
| `plan_policy` | "loose" | 计划约束域（loose/strict） |
| `max_plan_steps` | 32 | 计划步数上限（0 = 禁用计划） |
| `plan_workflow` | None | WorkflowSpec 约束域 |
| `evaluator` / `branch_mixer` | None | 推演评估器/调配策略 |
| `max_simulations` | 8 / `simulate_concurrency` 2 | 推演分支护栏 |
| `assembly` | None | InputAssembler 装配配置 |
| `metrics` | None | TurnMetrics 回合指标聚合 |

保留键：节点返回 `__plan__`（重规划）/ `__spawn__`（子任务）/
`__simulate__`（推演）——不进状态，随 checkpoint 版本化。

## 状态与补丁（core.state / core.patch_chain）

- 内置 reducer：`add_messages`（累积）/ `merge_dicts` / `merge_metrics`（加和）
  / `last_value`（默认）/ `patch_chain`；`register_reducer(name, fn, additive=)` 自定义
- `StateSchema.apply(state, delta)`：按通道 reducer 合并增量
- `PatchChain`：`append(patch)` / `assemble(mode="full"|"base_only"|"partial")`
  / `rebase()`（压扁）/ `truncate(n)` / `branch()`；`Patch(kind=PatchOp.APPEND|REPLACE|DELETE, path, value)`

## 事件（core.events / core.event_types）

- `EngineEvent` 字段：`type/payload/step_id/parent_step_id/round_id/node/
  graph_path/seq/trace_id/thread_id/version`；`to_dict()/from_dict()/to_json()`
- `EngineTransport` 协议：仅 `send(event)`；`CollectorTransport` 内存收集
- `EventTypeSpec(name, schema=None, renderer=None, system=False, meta=None)`
  + `EventTypeRegistry`：`register`/`classify(etype, payload)`（宽松：未注册
  类型不阻断，仅折叠）；`system=True` 注入 `RunOptions.system_events`

## 存储（core.storage）

```python
storage = create_storage("memory://")                 # 内存
storage = create_storage("sqlite:///./demo.db")       # aiosqlite
storage = create_storage("postgresql://user:pass@host/db")  # asyncpg
```

`Storage` 协议（三通道统一）：checkpoint 系列
（`get_checkpoint`/`get_latest_checkpoint`/`put_checkpoint(record, *,
expected_version=None, fork=False)`/`list_checkpoints`/`chain_index`/
`delete_checkpoints`/`set_checkpoint_parent`）、事件日志
（`append_event`/`events_after`/`truncate_events`/`trim_events`/
`latest_event_seq`）、records（`put_record`/`get_record`/`list_records`）
+ `close()`。敏感键写入前自动剥离；并发写乐观锁。自定义后端实现此协议。

## 中断与审批（core.interrupt / core.approval）

```python
from ink_engine.core.approval import (
    DECISION_ACCEPT, DECISION_EDIT, DECISION_REJECT, DECISION_TERMINATE, DECISION_AUTO,
    DefaultInterruptPolicy, approve_batch, approve_before_execute,
)
```

- `await approve_before_execute(ctx, key, action, payload=None, policy=None, *, clock=None)` → `ApprovalDecision`
- `await approve_batch(ctx, key, actions, policy=None)` → 合并卡（同回合多写聚合）
- `DefaultInterruptPolicy(auto_approve_keys=frozenset(), auto_approve_tools=frozenset(), timeout=None)`
- `InterruptPolicy` 协议：`should_approve(key, action) -> bool` /
  `timeout_for(key, action) -> float | None`
- 超时/非法注入一律 reject（fail-closed）；`ApprovalDecision` 含
  `decision/action/edited_content/reason/source`

## 规则与知识（core.rules / core.knowledge_set / core.knowledge_gate）

- `RuleTypeRegistry.register(name, predicate)`；内置谓词：`present/absent/
  equals/not_equals/compare/not_in_enum/in_enum/not_contains/contains/
  unique_pairs/truthy/falsy/state_transition`
- `RuleSet.parse(data, registry=...)`（建期拒绝未知谓词/重复 id）；
  `RuleEngine(registry).evaluate(rule_set, data, context=None)` →
  `RuleCheckResult(issues, skipped, broken, checked)`
- 样例库：`FixtureSet(name, cases)` + `FixtureCase(id, data, context=None,
  expected_pass, expected_kinds=())`；`assert_fixtures_pass(...)`（非谈判项）
- `KnowledgeSet(user_id, *, storage=None, chain=None)`：`entries/get/add/
  update`（精准补丁）/`remove/archive/unarchive`/`record_usage`/
  `promote`（work→project→user）/`export/from_export`/`save/load`/
  `search(query, level, kind, limit=5)`；`seed_knowledge_set(ks, entries)` 幂等注入
- `KnowledgeGate(l2_executor=...)`：`check(entry, schema, fixtures,
  old_metrics=None, new_metrics=None, regression=None, ...)` → `(l1, l2, l3)`；
  `scan_text_injection(text, patterns=None)` 指令注入扫描
- `WeightedScorer(config)` + `ScoringConfig(dimensions, overall_threshold)`
- `SchemaSpec(name, fields)` + `SchemaField(name, required, kind, enum,
  min, max, pattern)`；`SchemaValidator.validate(schema, data) -> list[str]`

## 调配与上下文（core.assembly / core.context）

- `ContextSource(type, content, title=None, weight=1.0, relevance=0.5,
  priority=5, ttl=None, max_chars=None, dedup_key=None, meta=None, created_at=None)`
- `ContextMixer(assembler=ContextAssembler(default_budget_chars=4000))`：
  `await mix(sources)` → `AssembledContext(text, included, dropped)`；
  `attach_fusion(hook, instruction=...)`（失败回退确定性组装）
- `WeightedBudgetAllocator`：score=weight×relevance，≥0.8 全保留 /
  ≥0.15 截断 / 低于丢弃；`CompressionPolicy` 可替换
- `AssemblyConfig(total_budget=8000, context_ratio=0.5, knowledge_ratio=0.3,
  tool_ratio=0.1, memory_ratio=0.05, evidence_ratio=0.05, max_tools=10,
  enabled=True)`；`InputAssembler(config).assemble(sources, ...)`；
  常量 `SOURCE_CONTEXT/KNOWLEDGE/TOOL/MEMORY/EVIDENCE`
- 节点内经 `ctx.assemble(...)` 调用（执行器接线入口）

## 运行时装配（core.runtime）——详见 hosts.md

- `Host` 协议：`create_storage()` / `resolve_llm()` / `interrupt_policy()` /
  `build_transport()` / `close()`
- `AssemblyRecipe` 22 字段：`set_id/seeds/harness_definitions/
  event_type_specs/entity_specs/ui_spec/ui_allowed_channels/
  ui_allowed_components/ui_allowed_theme_tokens/tool_wiring/
  vetting_static_hooks/vetting_l2_hook/approval_levels/retrieval_sources/
  apply_targets/graph_recipe/on_reverted/convergence_provider/run_options/
  compress_policy/verify_retry_limit/emit_timeline_events`
- `Runtime`：`await boot(host, recipe)`（幂等）→ 自返回；`state()` /
  `pause()` / `resume()` / `await stop()`；`begin_run()` / `end_run(ticket)`；
  `await resume_run(thread_id, inject)`（审批决议重入样板）；
  `await rebuild_engine(llm=None)`（缓存键 = 模型身份 + 存储身份 +
  工具结构身份）；
  `engine` 属性（当前装配产物）
- `ToolWiring(self_specs, self_executor_factory, self_operation_of)` 工具三路分发

## 自指演化与实体（core.self_tools / core.self_proposal / core.self_application / core.entities / core.entity_evolution）

- 契约工具：`self_tool_specs` / `make_self_executor` / `operation_of` /
  `SelfToolContext`；`SELF_TOOL_CONTRACT` = 6 演化工具名
  （propose_patch/apply_patch/revert_patch/propose_domain_manifest/
  search_tools/request_tool）
- 观察工具：`introspection_tool_specs` / `make_introspection_executor`（六
  inspect_*，恒定 JSON 信封，只读 + 敏感键剥离）
- `SelfProposal(kind, payload, base_version=1, rationale=None, meta=None)`；
  `PatchKind`：`ui/theme/tool/rule/knowledge/harness/event_type/environment/
  artifact/entity`（10 类）；`ProposalValidator.validate(proposal) -> list[str]`
- `ApprovalLevel`：`L0`（策略直过）/`L1`（弹卡）/`L2`（沙箱验证 fail-closed）
- `SelfApplicationPipeline(storage, validator, policy, levels, l2_vetting,
  targets)`：`await apply(ctx, proposal, round_id)` → `PatchOutcome`；
  `await revert(ctx, patch_id, reason, round_id)`（仅链尾）；
  `audit_log(limit=100)`；`GuardedStorage` 旁路写防护（演化资产集合 +
  `knowledge:`/`harness:`/`event_types:`/`entities:` 前缀直写拒绝）
- `EntityRegistry`：`EntitySpec(id, label, persona=None, model=None,
  meta=None)`，`register`/`get`/`list`/`replace`（`entities:<set_id>` 集）；
  `EntityEvolutionPipeline`（失败信号 → 变异 → 三层闸门 → 替换/晋升）
- `GrowthPipeline`（`GrowthConfig(enabled=True, ...)`）：回合事件 → 信号
  缓冲 → 按需蒸馏 → `KnowledgeGate` 三层 → 知识集落位（引擎自承载，
  装配自动接线）
- 输出验证：`OutputVerifier`/`LLMOutputVerifier` + `OutputVerificationError`
  （`RunOptions.output_verifier` + 装配配方 `verify_retry_limit`）

## 工具与安全（core.tool_pipeline / core.permissions / core.sandbox / core.declarative_tools / core.tool_vetting / core.mcp_client）

- `ToolSpec(name, description="", parameters=None, permissions=())`；
  `to_openai_tools(specs)` schema 转换
- `ToolPipeline(gate=None, extractor=None, sandboxes=(), guards=(),
  executor=None, audit=None, max_result_chars=100_000, allow_unchecked=False,
  trace_sink=None)`：`await execute(ctx, spec, args)` → `ToolResult(ok,
  decision, output, overflow, approval, error)`
- `PermissionGate(default_policy="deny", review_tier=None)`：
  `check(tool, operation, target, *, permissions=())` → `GateResult`；
  `parse_permission("domain:action:pattern")`；`NetworkPolicy(allow_domains)`
- `FileSandbox(root)`：`validate(operation, target) -> Path`；`snapshot_before(path)` 写前快照
- `ProcessSandbox(allowlist=(), timeout=30.0, cwd=None, max_output=100_000, env=None)`：
  `run(command, args=())` → `ProcessResult(exit_code, stdout, stderr, timed_out)`
- `DeclarativeToolSpec(name, description, parameters, permissions, endpoint,
  endpoint_config, meta=None, network_policy=None)`；`EndpointType`（内置）：
  `http_fetch/process_exec/file_ops/mcp/web_search/collab_request/task_manager`；
  `endpoint_operation(endpoint, args, *, config=None)`；
  `EndpointTypeRegistry`/`EndpointTypeSpec`（自定义端点注册：动作域/
  配置必填键/契约输出形态/提取与失败原因钩子/沙箱守卫接线）；
  `endpoint_registry`（模块级内置注册表）；
  `DeclarativeToolExecutors.register_definition/register/dispatch`；
  `build_declarative_pipeline(executors, network_policy=None,
  network_unlisted_policy="review")`（自动接线沙箱，默认网络审批即网关）；
  `make_http_fetch_executor(timeout=30.0, max_chars=100_000)`
- `ToolVetting(*, static_hooks=())`：`vet(manifest, code_paths=(), *,
  strict=False)`；`shadow_run(executor, args, *, workdir)`（结果恒 untrusted）；
  `ToolManifest(name, source, signature=None, hashes, permissions, ...)`
- `McpServerConfig(id, transport=McpTransport.HTTP, url=None, headers=None,
  command=None, args=(), env=None, source=UNKNOWN, signature=None,
  server_factory=None)`；`McpClientManager`：`connect(config)` /
  `disconnect(id)` / `close_all()` / `import_tools(id, *, source, vetting,
  signature)`（仅放行 VERIFIED）/ `register_mcp_executor(executors, manager)`

## LLM 层（core.llm，可选 extra [llm]）——详见 extensions.md 第 2 节

- `AsyncLLM` 协议：`ainvoke(messages, *, tools=None, params=None)` /
  `astream(...)` → `AsyncIterator[LLMChunk]` / `aclose()`
- `Message` 工厂：`system/user/assistant/tool_result(content, tool_call_id=...)`；
  `ToolCall(id, name, arguments)`，`parse_arguments(*, strict=False)`
- `LLMConfig(adapter, model_id, base_url, api_key=None, temperature=None,
  max_tokens=None, request_timeout=None, extra=None)`；`create_llm(config)`；
  `register_adapter(name, cls)`；`LLMChunk`/`LLMResult`/`collect_result`
- 内置适配器：`openai_compatible`（规范名，chat/completions）/
  `openai_responses`（Responses）/`anthropic_messages`（Messages）/`gemini`
  + 兼容别名（`openai_compat`/`openai_response`/`anthropic`）+ 厂商别名
  （openai/deepseek/zhipu/moonshot/ollama，改 base_url 适配）；DashScope
  走 compatible-mode 端点
- `ModelChain(configs, retry=RetryPolicy(attempts=3, base_delay=1.0,
  max_delay=10.0), create=create_llm)`：`ainvoke`/`astream`（认证失败
  fail-closed 不切备用）
- `create_embedder(config)` / `AsyncEmbedder`（`aembed_query`/
  `aembed_documents`）；`to_openai_tools(specs)`

## 种子（core.seeds / seeds.boot）

- `seed_general(ks)` / `build_general_seed_entries()`；`SeedProvider =
  Callable[[], list[KnowledgeEntry]]`；`GENERAL_TEMPLATE_SEED_ID` /
  `GENERAL_WEIGHTS_SEED_ID`
- `ink_engine.seeds.boot`：`build_boot_seed_entries()` / `BOOT_SYSTEM_PROMPT` /
  `BOOT_UI_SPEC` / `BOOT_EVENT_TYPES` / `boot_harness_definition()` /
  `BOOT_METATOOLS`——装配配方 `AssemblyRecipe(seeds=[("boot", build_boot_seed_entries)])` 直注

## 其他常用原语

- `fan_out(tasks, limit, propagate=())`：并发发散（部分失败剔除）
- `BudgetManager.register(policy)` / `check(ctx)`（`BudgetPolicy` 协议）
- `StateMachine(name, states, allowed=None)`：`append(transition)` /
  `rollback(steps)`；`RoundSteps`：`user/reply_token/review_card/
  tool_*/node_*/thinking_*/plan_*/error` 步骤累积（step_id 稳定）
- `tiers`：`tier_key` / `resolve_tier_config(model_config, tier)` /
  `build_tier_chain(...)` / `TierCallStats`
- `memory`：`MemoryQuery(namespace, kind=None, source=None, limit=None)` /
  `StorageBackedMemoryStore(storage)` / `PriorityRecallPolicy`
- `retrieval`：`RetrievedChunk(source, doc_id, text, relevance=0.0, level=...)` /
  `RetrieverRegistry`（`register`/`retrieve(query, limit=8, levels=None)`，
  注入扫描剔除）
- `review`：评审/再生成由使用方实现协议（`Reviewer.review(candidates,
  context)` / `Regenerator.regenerate(...)` / `WebVerifier.verify(claim)`），
  收敛判定 `MaxRoundsConvergencePolicy(threshold=0.75, beam=1,
  max_rounds=2).decide(reviews, *, round_no)` → `ConvergenceDecision`，
  结果 `ConvergenceResult(best_index, converged, ...)`——评审循环由
  使用方驱动
- `workflow`：`WorkflowSpec(name, nodes, edges)` / `build_workflow_graph(spec)`
- `security`：`is_sensitive_key(key)` / `strip_sensitive(value)`（纯函数，
  落库/出网/日志同规格）；`logging.configure_engine_logging(level=INFO)`（幂等）
- `ui_schema`：`UISpec(name, root)` / `UISchemaValidator.validate(spec,
  allowed_components, allowed_channels, allowed_theme_tokens)` /
  `UIRenderer.render(spec)`
