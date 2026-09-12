// gate: 超限(768 行) - 引擎公共面 re-export 注册表（单一不可拆收敛面，计划 §4.5；engine/src/index.ts 只转发本面）
/**
 * @ink-ts/engine 面向宿主的精选公共面（只 re-export，不实现）。
 *
 * 收敛面（计划 §4.5）：本面是 dock 唯一公共出口，engine/src/index.ts 仅一行转发
 * （宿主 @ink-ts/engine import 符号零改动）。分组：
 * 1. 运行时装配（Runtime 类 + RuntimeConfig 等装配入口）；
 * 2. 核心机制公开面（宿主组装命令面：图/补丁/执行器/事件/状态/审批/
 *    自指应用/存储 seam/LLM 契约/声明式工具/编排/索引/环境/schema/ui/
 *    权限沙箱/链接校验/事件类型/恢复/中断/预算/结点契约等）；
 * 3. adapters 工厂面（存储后端工厂、LLM 协议注册、MCP client）；
 * 4. 引擎错误类型族。
 *
 * 汇总声明面（同一模块整段 star 聚合，符号与本面下方各语句全等，仅立语义
 * 分组口径）：dock/caps.ts（插件能力注册面，计划 §4.2）、dock/calls.ts
 * （调用面，§4.3）、dock/view.ts（渲染对接面，§4.4）。dock/ports.ts 与
 * dock/registry.ts 是四件→dock 层向白名单的内部声明面，不入本公共面
 * （保持现有符号集，计划 §2/§5.1.1）。
 *
 * 取舍：目录自带 index 收敛者整组具名透传；同名类型跨层冲突（如
 * kernel/sandbox 的 SpawnSeam 进程沙箱 seam 与 adapters/mcp 的 SpawnSeam
 * stdio 生成 seam）按语义保留 core 名、adapters 名显式别名导出
 * （McpSpawnSeam），不做 export * 撞名。不导出 `_` 前缀私有文件；值面
 * 枚举与 data plane 常量收编自引擎内置数据面生成物（engine/schemas +
 * fixtures → core/contracts/generated，见下方「数据面契约」组），单一真源。
 */

export * from './caps.js';
export * from './calls.js';
export * from './view.js';

// ── 4. 引擎错误类型族 ──
export * from '../model/errors.js';

// ── 1. 运行时装配 ──
export { AssemblyRecipe, Runtime, RuntimeState, RunTicket, set_runtime_clock } from '../kernel/runtime/index.js';
export type {
  AssemblyRecipeInit,
  AssemblySourceProvider,
  EvolveOfflineOptions,
  EvolveOfflineResult,
  Host,
  RunTaskHandle,
  RuntimeConfigInit,
  ToolWiring,
} from '../kernel/runtime/index.js';

// ── 2. 核心机制公开面 ──

// 图（数据即图，宿主按 SchemaSerializable 组装/序列化）
export * from '../model/graph/graph.js';
export * from '../model/graph/graph_types.js';

// 引擎内置基础节点类型（llm_decider/tool_pipeline/回环条件边/池种子：数据图
// 按类型名引用即解析执行；注册面供装配方把基础执行体装进 NodeTypeRegistry；
// P4.2a-3 可区分实例 llm_planner/llm_reviewer/llm_main/router_plan_judge：
// 实例键独立 + executor 解耦 + 实例契约随 config 派生）
export {
  CFG_OUTPUT_FIELD,
  CFG_READ_FIELDS,
  COND_LLM_FINISHED,
  COND_LLM_PENDING,
  COND_ROUTE_PREFIX,
  ENGINE_DEFAULT_TOOL_ROUNDS,
  ENGINE_STUB_REPLY,
  ROLE_TERMINAL,
  STATE_MESSAGES,
  STATE_PENDING,
  STATE_PLAN,
  STATE_REPLY,
  STATE_RESULTS,
  STATE_REVIEW,
  STATE_ROUND_MODEL,
  STATE_ROUND_POSE,
  STATE_ROUTE_TO,
  STATE_STEP_ARGS,
  STATE_TOOL_ROUNDS,
  TYPE_LLM_DECIDER,
  TYPE_LLM_MAIN,
  TYPE_LLM_PLANNER,
  TYPE_LLM_REVIEWER,
  TYPE_ROUTER_JUDGE,
  TYPE_ROUTER_PLAN_JUDGE,
  TYPE_TOOL_PIPELINE,
  bind_engine_node_seams,
  build_read_projection,
  config_read_fields,
  default_engine_pool_seed,
  default_engine_seed_edges,
  derive_instance_contract,
  has_engine_executor,
  is_reserved_output_key,
  parse_output_field_key,
  register_engine_node_types,
  register_route_edge_condition,
  register_route_edge_conditions,
  route_condition_name,
} from '../core/nodes/index.js';
export type {
  EngineNodeSeams,
  EngineNodeTypeSeed,
  EnginePoolSeed,
} from '../core/nodes/index.js';

// 补丁链（Patch/Path/PatchOp/AssembleMode 数据面 + 链操作）
export * from '../kernel/patch/patchChain.js';

// 执行器入口（Engine/run_subgraph/节点上下文协议）
export { Engine, run_subgraph } from '../kernel/executor/index.js';
export type { EngineBase, ExecuteOptions, NodeContext } from '../kernel/executor/index.js';

// 单轮运行结果（RunOptions/RunResult 等）
export * from '../core/run_result/run_result.js';

// 事件协议（EngineEvent/传输 seam/协议版本错误）
export {
  CollectorTransport,
  EngineEvent,
  PROTOCOL_VERSION,
  ProtocolVersionError,
  parse_event_lenient,
} from '../core/events/events.js';
export type { EngineEventInit, EngineTransport } from '../core/events/events.js';

// 事件展示聚合器（从事件流派生展示态消息流；宿主经 transport 接入采集）
export { DisplayStreamCollector, type DisplayMessage } from '../kernel/display/display_stream.js';

// 状态（Reducer 注册 + StateSchema/Channel）
export * from '../core/state/reducers.js';
export * from '../core/state/schema.js';

// 审批卡辅助（approve_before_execute/approve_batch/决策形态）
export * from '../kernel/approval/approval.js';

// 自指应用管线（SelfApplicationPipeline/GuardedStorage/分级表等）
export * from '../kernel/self_application/index.js';

// 存储 seam（Storage 接口 + checkpoint/链记录数据形态 + 协议常量）
export * from '../core/storage/storage.js';
export * from '../core/storage/storage_records.js';
export * from '../core/storage/storage_constants.js';

// LLM 机制契约（base/messages/tools/errors/fallback/cache，core 纯 seam）
export * from '../kernel/llm/index.js';

// 统一工具执行流水线（ToolPipeline.execute = 引擎工具执行 seam：权限门禁 →
// 沙箱守卫 → 审批 → 分发；宿主 agent 节点经此执行工具）
export { ToolPipeline, ToolResult } from '../kernel/tool_pipeline/tool_pipeline.js';
export type {
  AuditSink,
  Executor,
  Extractor,
  FailureReasonHook,
  GateSeam,
  Guard,
  SandboxSeam,
  TraceSink,
} from '../kernel/tool_pipeline/tool_pipeline.js';

// 声明式工具（端点注册表/工具定义/执行体注册/流水线/结点契约映射）
export * from '../core/declarative_tools/index.js';

// 工具编排与索引（WeightedToolScorer/ToolSelector/ToolVectorIndex）
export * from '../core/tool_orchestrator/tool_orchestrator.js';
export { ToolVectorIndex } from '../core/tool_index/tool_index.js';
export type { AsyncEmbedderType, EndpointsType } from '../core/tool_index/tool_index.js';

// 环境装配（EnvironmentSpec/EnvironmentHandle/Provider 面）
export * from '../core/environments/index.js';

// Schema 校验（SchemaField/SchemaSpec/SchemaValidator；FieldKind 与
// 引擎内置数据面生成物同源）
export * from '../model/schema/schemaValidator.js';

// UI schema（三层白名单校验/渲染器 seam）
export * from '../model/ui_schema/uiSchema.js';

// 权限与沙箱安全类型（PermissionGate/NetworkPolicySandbox/文件与进程沙箱；
// SpawnSeam = core 进程沙箱的宿主注入 seam）
export * from '../kernel/permissions/permissions.js';
export {
  FS_OPERATIONS,
  FileSandbox,
  FileSnapshot,
  ProcessResult,
  ProcessSandbox,
  snapshot_before,
} from '../kernel/sandbox/index.js';
export type { FileOps, FsOperation, SpawnHandle, SpawnSeam } from '../kernel/sandbox/index.js';

// 链接校验（输出字段 ↔ 消费字段的前驱可达性）
export * from '../core/link_validator/link_validator.js';

// 事件类型（registry/specs，演化事件声明面；register_* 注册函数族为装配期
// 内部动作——宿主经 EventTypeRegistry + 数据规格函数显式装配，不随公共面外泄）
export * from '../model/event_types/registry.js';
export * from '../model/event_types/eventTypeSpec.js';
export {
  EVENT_AUDIT_JUNCTION,
  EVENT_AUDIT_POLICY_REVIEW,
  EVENT_AUDIT_PROMOTION,
  EVENT_TURN_STARTED,
  EVENT_EXECUTION_STARTED,
  attachment_event_spec,
  audit_event_specs,
  output_gate_event_specs,
} from '../model/event_types/eventTypeSpecs.js';

// 恢复 / 中断 / 预算（ResumeResolution/InterruptCoordinator/BudgetManager；
// BudgetExceededError = 预算硬检查终止错误，属预算机制本模块）
export * from '../kernel/recovery/index.js';
export * from '../kernel/interrupt/interrupt.js';
export {
  BudgetExceededError,
  BudgetManager,
  BudgetRemaining,
  can_afford,
} from '../kernel/budget/budget.js';
export type { BudgetPolicy, BudgetQuery } from '../kernel/budget/budget.js';

// 结点契约（NodeContract/QualityGate 等公开类型）
export {
  CONTRACT_VERSION_MIN,
  SAFETY_TIER_MAX,
  SAFETY_TIER_MIN,
  NodeContract,
} from '../model/contracts/contracts.js';
export type {
  NodeContractInit,
  QualityGate,
} from '../model/contracts/contracts.js';

// 回合步骤记录形态（RoundSteps 主类仍为 executor 侧消费；宿主经 runtime
// round_steps() 取 StepRecord 命名返回类型）
export type { StepRecord } from '../kernel/round_steps/index.js';

// 自学习族可装配面（memory/记忆抽取/技能结晶/离线进化/自适应调参；宿主经
// 这些构造器装配自管存储或读取运行时默认装配产物）
export {
  MemoryEntry,
  PriorityRecallPolicy,
  StorageBackedMemoryStore,
} from '../core/memory/index.js';
export type {
  IdGenFn,
  MemoryEntryInput,
  MemoryEntryOptions,
  MemoryQuery,
  MemoryRecallPolicy,
  NowFn,
  StorageBackedMemoryStoreOptions,
} from '../core/memory/index.js';

export {
  CONFIRMATION_EVENTS,
  DEFAULT_NAMESPACE,
  MemoryExtractSettleHook,
  ROUND_FACT_EVENTS,
  arbitrate_and_store,
  extract_entries_from_ledger,
} from '../kernel/memory_extract/index.js';
export type {
  ArbitrateStoreResult,
  LedgerFactsProvider,
  MemoryExtractArbitration,
  MemoryExtractSettleHookOptions,
} from '../kernel/memory_extract/index.js';

export {
  KnowledgeSkillStore,
  SkillCrystallizeHook,
  SkillStore,
  crystallize_from_cache,
  knowledge_entry_to_skill,
  skill_to_knowledge_entry,
} from '../kernel/skill_crystal/index.js';
export type {
  CacheEntryLike,
  CacheEntrySource,
  SkillStoreLike,
  KnowledgeSkillStoreOptions,
  SkillStoreOptions,
} from '../kernel/skill_crystal/index.js';

export {
  DeterministicMutation,
  EvolutionCandidate,
  EvolutionFactory,
  EvolutionOutcome,
  entry_metrics,
} from '../kernel/evolution/index.js';
export type { EvolutionGate, MutationStrategy } from '../kernel/evolution/index.js';

export {
  AUTO_ROUND_ID_PREFIX,
  MetaTuner,
  ParamRegressionExecutor,
  ParameterSnapshot,
  TunableParams,
  TuneResult,
  TurnMetrics,
  is_auto_round_id,
} from '../kernel/tuning/index.js';
export type {
  MetaTunerOptions,
  ParameterSnapshotInit,
  TunableParamsInit,
  TurnMetricsInit,
} from '../kernel/tuning/index.js';

// 角色槽模型配置解析（模型按角色槽配置/回落语义，CODING §8 锚点；宿主
// config 按槽解析模型配置形态并建链，不复制回落语义）
export {
  ROLE_AGENT,
  ROLE_ROUTER,
  build_role_model_chain,
  resolve_role_model,
} from '../model/model_roles/index.js';
export type { RoleModelChain } from '../model/model_roles/index.js';

// 自指契约工具三路声明（tool_wiring 配方组件：宿主只装配声明，机制不复制）
export { SELF_TOOL_CONTRACT } from '../kernel/self_tools/index.js';
export { make_self_executor, operation_of, self_tool_specs } from '../kernel/self_tools/index.js';
export type {
  SelfToolContext,
  SelfToolExecutor,
  SelfToolNodeContext,
} from '../kernel/self_tools/index.js';

// 数据面契约（引擎内置生成物再导出：engine/schemas + fixtures →
// core/contracts/generated，勿手改；宿主/上层一律经本公共面取用，
// 不再存在独立契约包）
export {
  APPROVAL_LEVELS,
  AUDIT_STATUSES,
  BUILTIN_ENDPOINT_NAMES,
  BUILTIN_ENDPOINTS,
  GUARDED_COLLECTIONS,
  GUARDED_PREFIXES,
  PATCH_KINDS,
  PATCH_OPS,
} from '../model/contracts/generated/index.js';
export type {
  AuditStatus,
  BuiltinEndpointName,
  BuiltinEndpointSpec,
  EndpointOutputField,
  KnownDefaultPatchKind,
  PatchKind,
} from '../model/contracts/generated/index.js';

// ── 执行组织数据面（作用域目录资产 / 通道条件资产 / 组织先验素材：声明面，
//    受控注册随实体/目录既有通道，执行语义由执行层落地）──
export {
  CAPABILITY_CLASS_FUNCTION,
  CAPABILITY_CLASS_ORGANIZATION,
  FACTORY_SCOPE_ROLES,
  SCOPE_GUARD_DEFAULT,
  SCOPE_ROLE_CODER,
  SCOPE_ROLE_COLLABORATOR,
  SCOPE_ROLE_CRITIC,
  SCOPE_ROLE_MAIN,
  SCOPE_ROLE_PLANNER,
  SCOPE_ROLE_SEARCHER,
  SCOPE_ROLE_SUBAGENT,
  SCOPE_ROLE_TESTER,
  is_factory_scope_role,
  parse_scope_decl,
  scope_decl_to_dict,
} from '../model/scopes/scope_spec.js';
export type {
  CapabilityClass,
  ScopeCapability,
  ScopeDecl,
  ScopeGuardLevel,
  ScopeIoBinding,
  ScopeIoContract,
  ScopeIoShape,
  ScopeRole,
} from '../model/scopes/scope_spec.js';
export {
  build_scope_asset,
  default_scope_directory_seeds,
  is_scope_asset,
  scope_decl_of,
} from '../model/scopes/scope_directory.js';
export type { ScopeAssetInit } from '../model/scopes/scope_directory.js';
// 作用域资产主载体（实体记录）与受控下架标记：宿主执行装配按公共面装载/识别
// 目录资产（同一实体受控通道），不深引引擎私有文件
export { EntitySpec, RETIRED_META_KEY } from '../core/entities/entities.js';
export {
  SCOPE_PRIOR_SINK,
  default_scope_priors,
  scope_prior_from_dict,
  validate_scope_prior,
} from '../model/scopes/scope_priors.js';
export type {
  ScopePriorHop,
  ScopePriorPattern,
  ScopePriorShape,
} from '../model/scopes/scope_priors.js';
export {
  CHANNEL_COMMITS,
  CHANNEL_COMMIT_BEST,
  CHANNEL_COMMIT_DECISION_ONLY,
  CHANNEL_COMMIT_DEFAULT,
  CHANNEL_COMMIT_FULL,
  CHANNEL_ID_MAX_LENGTH,
  CHANNEL_SHAPES,
  CHANNEL_SHAPE_DELEGATE,
  CHANNEL_SHAPE_FAN_IN,
  CHANNEL_SHAPE_FAN_OUT,
  CHANNEL_SHAPE_RETURN,
  ChannelSpec,
  default_channel_conditions,
  normalize_conditions,
  validate_channel_id,
} from '../model/channels/channel_spec.js';
export type {
  ChannelCommit,
  ChannelConditions,
  ChannelShape,
  ChannelSpecInit,
} from '../model/channels/channel_spec.js';
export { ChannelDirectory, default_channel_seeds } from '../model/channels/channel_directory.js';

// ── 执行组织档案数据面（轨迹记录 / 组织模式统计 / 择优建议：纯数据面 +
//    advisory，受控演化应用经审批 + 补丁链 + Guard 接线，不在本面执行）──
export {
  RUN_ID_MAX_LENGTH,
  TRAIL_OUTCOMES,
  TRAIL_SCHEMA_VERSION,
  parse_execution_trail,
  trail_to_dict,
  validate_execution_trail,
  validate_run_id,
  validate_scope_ref,
} from '../core/org_archive/execution_trail.js';
export type {
  ExecutionTrail,
  TrailCost,
  TrailHop,
  TrailOutcome,
} from '../core/org_archive/execution_trail.js';
export {
  ORG_ARCHIVE_SCHEMA_VERSION,
  OrgArchive,
} from '../core/org_archive/org_archive.js';
export type { OrgArchiveEntry } from '../core/org_archive/org_archive.js';
export {
  chain_key_of,
  chain_pattern_key,
  chains_of_trail,
  decode_chain_key,
  decode_transition_key,
  hop_commit,
  hop_fan_width,
  scope_usage_of_trail,
  transition_key_of,
  transition_pattern_key,
  transitions_of_trail,
} from '../core/org_archive/org_patterns.js';
export type {
  OrgChainPattern,
  OrgTransitionPattern,
  TrailScopeUsage,
} from '../core/org_archive/org_patterns.js';
export {
  empty_org_stats,
  failure_rate,
  org_stats_from_dict,
  org_stats_to_dict,
  record_observation,
  success_rate,
} from '../core/org_archive/org_stats.js';
export type { OrgStats } from '../core/org_archive/org_stats.js';
export {
  ORG_DOWNRANK_FAILURE_RATE,
  ORG_DOWNRANK_MIN_EVIDENCE,
  ORG_KEEP_MIN_EVIDENCE,
  ORG_KEEP_MIN_SUCCESS_RATE,
  ORG_MIN_EVIDENCE,
  ORG_PROPOSAL_KIND_ORDER,
  ORG_RETIRE_FAILURE_RATE,
  ORG_RETIRE_MAX_USAGE,
  ORG_RETIRE_MIN_EVIDENCE,
  ORG_SHORTCUT_MAX_TERMINAL_RATIO,
  ORG_SHORTCUT_MIN_EVIDENCE,
  ORG_SHORTCUT_MIN_SUCCESS_RATE,
  default_pruning_thresholds,
  evaluate_org_archive,
  proposal_confidence,
  suggest_downranks,
  suggest_keeps,
  suggest_retires,
  suggest_shortcuts,
} from '../core/org_archive/pruning.js';
export type {
  DownrankProposal,
  KeepProposal,
  OrgEvaluateOptions,
  OrgModeRef,
  OrgProposal,
  OrgProposalKind,
  PruningThresholds,
  RetireProposal,
  ShortcutProposal,
} from '../core/org_archive/pruning.js';

// ── 组织先验覆盖资产（org_priors 集合条目形态：route 覆写 / shortcut 直连 /
//    weight 降权；受控演化应用在 org_priors:<set_id> 集合持久化覆盖行）──
export {
  ORG_PRIORS_COLLECTION_PREFIX,
  OrgPriorOverlay,
  org_priors_collection,
  route_overlay,
  shortcut_overlay,
  shortcut_overlay_id,
  weight_overlay,
  weight_overlay_id,
} from '../model/scopes/prior_overlay.js';
export type {
  OrgPriorOverlayPayload,
  OrgPriorRoutePayload,
  OrgPriorShortcutPayload,
  OrgPriorWeightPayload,
} from '../model/scopes/prior_overlay.js';

// ── 受控演化接口（P5-γ：统一提案 + 采纳前验证闸 + 目录感知应用计划 +
//    受控应用层 + Wave-2 择优适配；作用域/通道/先验资产的唯一受控通道）──
export {
  EVOLUTION_KIND_ORDER,
  EVOLUTION_PROVENANCES,
  PROVENANCE_AGENT,
  PROVENANCE_ORG,
  PROVENANCE_USER,
  SCOPE_EVOLUTION_KINDS,
  CHANNEL_EVOLUTION_KINDS,
  PRIOR_EVOLUTION_KINDS,
  EvolutionProposal,
  is_channel_kind,
  is_prior_kind,
  is_scope_kind,
  payload_violations,
} from '../core/controlled_evolution/evolution_proposal.js';
export type {
  DownrankModeRef,
  EvolutionProposalInit,
  EvolutionProposalKind,
  EvolutionProvenance,
} from '../core/controlled_evolution/evolution_proposal.js';
export {
  GATE_ADDITIVE_KINDS,
  GATE_MANDATORY_KINDS,
  classify_gate_requirement,
  run_adoption_gate,
  trial_spec_for,
  verdict_blocks,
} from '../core/controlled_evolution/adoption_gate.js';
export type {
  AdoptionGateOptions,
  AdoptionGateOutcome,
  GateRequirement,
  TrialRunner,
  TrialSpec,
  TrialVerdict,
} from '../core/controlled_evolution/adoption_gate.js';
export { plan_evolution } from '../core/controlled_evolution/apply_plan.js';
export type {
  ApplyPlanContext,
  ApplyPlanResult,
  EvolutionPlanStep,
  PlanChannelDirectory,
  PlanEntityDirectory,
} from '../core/controlled_evolution/apply_plan.js';
export {
  DOWNRANK_PRIOR_WEIGHT,
  adapt_pruning_proposals,
  evaluate_and_adapt,
} from '../core/controlled_evolution/pruning_adapter.js';
export type { PruningAdaptation } from '../core/controlled_evolution/pruning_adapter.js';
export {
  ControlledEvolutionApplier,
} from '../core/controlled_evolution/controlled_applier.js';
export type {
  ControlledEvolutionApplierInit,
  EvolutionApplyReport,
} from '../core/controlled_evolution/controlled_applier.js';
export {
  CRYSTALLIZE_MIN_SIGHTINGS,
  CRYSTALLIZE_MIN_SUCCESS_RATE,
  CRYSTALLIZE_ID_PREFIX,
  CRYSTALLIZE_SAMPLE_CAP,
  CRYSTALLIZE_EVIDENCE_SOURCE,
  TEMP_SIGHTING_OUTCOMES,
  normalize_temp_sighting,
  crystallize_asset_id,
  evaluate_temp_sightings,
} from '../core/controlled_evolution/crystallize.js';
export type {
  TempSightingOutcome,
  TempSighting,
  CrystallizeCatalogState,
  CrystallizeOptions,
  CrystallizePatternStat,
  CrystallizeEvaluation,
} from '../core/controlled_evolution/crystallize.js';
export {
  ORG_THRESHOLD_CONFIG_KEYS,
  normalize_org_evaluate_thresholds,
  effective_org_evaluate_thresholds,
} from '../core/controlled_evolution/evaluate_options.js';
export type {
  OrgThresholdDomain,
  OrgThresholdNormalization,
} from '../core/controlled_evolution/evaluate_options.js';

// ── 执行运行时（P5-δ：作用域装载 / 通道执行 / 汇聚点合成 / 护栏；含 __next
//     路由数据面、路由规划、通道条件、归并语义、护栏与隔离试跑基座）──
export * from '../core/execution_runtime/index.js';
export type { RoundModelOverride } from '../core/execution_runtime/runtime_types.js';
export type { BoardWriteOutcome } from '../core/execution_runtime/board_runtime.js';

// ── 受控白板（会话内共享上下文数据面：块模型 / 授权 / 纯数据面状态机，
//    纯 JSON 进 JSON 出、零 IO；可见性唯一裁决源，未授权默认拒绝 fail-closed，
//    审计 scope×block×action；供 6A3 集成波与 6C convene 波装配）──
export {
  BLOCK_KINDS,
  MAIN_SCOPE,
  WHITEBOARD_VERSION,
  Whiteboard,
  WhiteboardAccessError,
  default_whiteboard_grants,
  is_whiteboard_block_kind,
  parse_whiteboard_block,
  parse_whiteboard_grants,
  whiteboard_block_to_dict,
} from '../core/whiteboard/index.js';
export type {
  DefaultGrantsOptions,
  WhiteboardAccess,
  WhiteboardAuditEntry,
  WhiteboardBlock,
  WhiteboardBlockKind,
  WhiteboardGrantEntry,
  WhiteboardGrants,
} from '../core/whiteboard/index.js';

// ── 协作裁决（圆桌归并去重/冲突检测/仲裁/收敛判据；纯数据面，供 6C convene 波装配）──
export {
  ARBITRATION_PRIOR,
  ARBITRATION_PRIORITY,
  ARBITRATION_QUALITY,
  ARBITRATION_USER,
  OPPOSE_MARKERS,
  USER_SCOPE,
  CONFIRM_MARKERS,
  DEFAULT_CONFIRM_K,
  DEFAULT_ROUNDS_CAP,
  adjudicate,
  arbitrate_conflict,
  build_synthesis,
  confirmers,
  dedupe_opinions,
  detect_conflicts,
  explicit_value,
  is_oppose_marked,
  judge_round,
  normalize_opinion_text,
  opinion_payload,
  opinions_digest,
  parse_opinion_entry,
  validate_opinion_schema,
} from '../core/collab/index.js';
export type {
  AdjudicationOptions,
  AdjudicationResult,
  ArbitrationBasis,
  ArbitrationOptions,
  ArbitrationPriority,
  ConflictPair,
  ConflictSuggestion,
  ConvergenceConfig,
  ConvergenceReason,
  ConvergenceVerdict,
  DedupeGroup,
  OpinionEntry,
  ParsedOpinion,
  RejectedOpinion,
  SynthesisConflict,
  SynthesisInput,
  SynthesisPoint,
} from '../core/collab/index.js';

// ── 受控白板授权块（上下文装载面：执行运行时读共享块经 AuthorizedBlock
//    契约；W6C2 缺口补透出）──
export type { AuthorizedBlock } from '../core/context/block_source.js';

// ── 3. adapters 工厂面 ──

// boot 引导种子（装配期数据资产：宿主配方经 AssemblyRecipe 直注消费）
export {
  BOOT_EVENT_TYPES,
  BOOT_METATOOLS,
  BOOT_PROMPT_SEED_ID,
  BOOT_SYSTEM_PROMPT,
  BOOT_UI_SPEC,
  boot_harness_definition,
  build_boot_seed_entries,
} from '../adapters/boot/index.js';

// 存储后端工厂（memory:// / sqlite:// 路由）
export * from '../adapters/storage/index.js';

// LLM 协议注册（协议注册与协议适配器创建）
export {
  adapter_names,
  create_llm,
  get_adapter_class,
  register_adapter,
} from '../adapters/llm/registry.js';
export type { LLMAdapterCtor } from '../adapters/llm/registry.js';

// MCP client（配置/注册表/会话/管理/传输；SpawnSeam 与 core 同名冲突 →
// 本层按语义别名 McpSpawnSeam）
export {
  BUILTIN_MCP_SERVERS,
  HttpMcpTransport,
  McpClientManager,
  McpConnectionLost,
  McpSessionHandle,
  McpToolImportError,
  McpTransport,
  McpServerConfig,
  MemoryMcpTransport,
  RpcChannel,
  RpcError,
  RpcTimeout,
  SdkSession,
  StdioMcpTransport,
  StdioRestartPolicy,
  SupervisedStdioSession,
  TaskCancelled,
  builtin_mcp_server_config,
  create_node_fs_seam,
  create_node_spawn_seam,
  extract_text,
  is_business_error,
  is_connection_lost,
  register_mcp_executor,
  result_is_error,
} from '../adapters/mcp/index.js';
export type {
  FetchLike,
  FetchResponseLike,
  McpCallResult,
  McpJsonRpcMessage,
  McpMessagePort,
  McpToolRecord,
  McpVettingLike,
  RawMcpSession,
  ServerFactory,
  SessionOpener,
  SessionOpenOptions,
  SpawnedMcpProcess,
} from '../adapters/mcp/index.js';
export type { SpawnSeam as McpSpawnSeam } from '../adapters/mcp/index.js';
