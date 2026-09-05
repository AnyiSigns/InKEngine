/**
 * @ink-ts/engine 面向宿主的精选公共面（只 re-export，不实现）。
 *
 * 分组：
 * 1. 运行时装配（Runtime 类 + RuntimeConfig 等装配入口）；
 * 2. 核心机制公开面（宿主组装命令面：图/补丁/执行器/事件/状态/审批/
 *    自指应用/存储 seam/LLM 契约/声明式工具/编排/索引/环境/schema/ui/
 *    权限沙箱/链接校验/事件类型/恢复/中断/预算/结点契约等）；
 * 3. adapters 工厂面（存储后端工厂、LLM 协议注册、MCP client）；
 * 4. 引擎错误类型族。
 *
 * 取舍：目录自带 index 收敛者整组具名透传；同名类型跨层冲突（如
 * core/sandbox 的 SpawnSeam 进程沙箱 seam 与 adapters/mcp 的 SpawnSeam
 * stdio 生成 seam）按语义保留 core 名、adapters 名显式别名导出
 * （McpSpawnSeam），不做 export * 撞名。不导出 `_` 前缀私有文件；值面
 * 枚举与 data plane 常量经 @ink-ts/contracts 单一真源。
 */

// ── 4. 引擎错误类型族 ──
export * from './core/errors.js';

// ── 1. 运行时装配 ──
export { AssemblyRecipe, Runtime, RuntimeState, RunTicket, set_runtime_clock } from './core/runtime/index.js';
export type {
  AssemblyRecipeInit,
  AssemblySourceProvider,
  GraphRecipeContext,
  Host,
  RunTaskHandle,
  RuntimeConfigInit,
  StaticVettingHook,
  ToolWiring,
} from './core/runtime/index.js';

// ── 2. 核心机制公开面 ──

// 图（数据即图，宿主按 SchemaSerializable 组装/序列化）
export * from './core/graph/graph.js';
export * from './core/graph/graph_types.js';

// 补丁链（Patch/Path/PatchOp/AssembleMode 数据面 + 链操作）
export * from './core/patch/patchChain.js';

// 执行器入口（Engine/run_subgraph/节点上下文协议）
export { Engine, run_subgraph } from './core/executor/index.js';
export type { EngineBase, ExecuteOptions, NodeContext } from './core/executor/index.js';

// 单轮运行结果（RunOptions/RunResult 等）
export * from './core/run_result/run_result.js';

// 事件协议（EngineEvent/传输 seam/协议版本错误）
export {
  CollectorTransport,
  EngineEvent,
  PROTOCOL_VERSION,
  ProtocolVersionError,
  parse_event_lenient,
} from './core/events/events.js';
export type { EngineEventInit, EngineTransport } from './core/events/events.js';

// 状态（Reducer 注册 + StateSchema/Channel）
export * from './core/state/reducers.js';
export * from './core/state/schema.js';

// 审批卡辅助（approve_before_execute/approve_batch/决策形态）
export * from './core/approval/approval.js';

// 自指应用管线（SelfApplicationPipeline/GuardedStorage/分级表等）
export * from './core/self_application/index.js';

// 存储 seam（Storage 接口 + checkpoint/链记录数据形态 + 协议常量）
export * from './core/storage/storage.js';
export * from './core/storage/storage_records.js';
export * from './core/storage/storage_constants.js';

// LLM 机制契约（base/messages/tools/errors/fallback/cache，core 纯 seam）
export * from './core/llm/index.js';

// 声明式工具（端点注册表/工具定义/执行体注册/流水线/结点契约映射）
export * from './core/declarative_tools/index.js';

// 工具编排与索引（WeightedToolScorer/ToolSelector/ToolVectorIndex）
export * from './core/tool_orchestrator/tool_orchestrator.js';
export { ToolVectorIndex } from './core/tool_index/tool_index.js';
export type { AsyncEmbedderType, EndpointsType } from './core/tool_index/tool_index.js';

// 环境装配（EnvironmentSpec/EnvironmentHandle/Provider 面）
export * from './core/environments/index.js';

// Schema 校验（SchemaField/SchemaSpec/SchemaValidator；FieldKind 与
// @ink-ts/contracts 数据面同源）
export * from './core/schema/schemaValidator.js';

// UI schema（三层白名单校验/渲染器 seam）
export * from './core/ui_schema/uiSchema.js';

// 权限与沙箱安全类型（PermissionGate/NetworkPolicySandbox/文件与进程沙箱；
// SpawnSeam = core 进程沙箱的宿主注入 seam）
export * from './core/permissions/permissions.js';
export {
  FS_OPERATIONS,
  FileSandbox,
  FileSnapshot,
  ProcessResult,
  ProcessSandbox,
  snapshot_before,
} from './core/sandbox/index.js';
export type { FileOps, FsOperation, SpawnHandle, SpawnSeam } from './core/sandbox/index.js';

// 链接校验（输出字段 ↔ 消费字段的前驱可达性）
export * from './core/link_validator/link_validator.js';

// 事件类型（registry/specs，演化事件声明面）
export * from './core/event_types/registry.js';
export * from './core/event_types/eventTypeSpec.js';
export * from './core/event_types/eventTypeSpecs.js';

// 恢复 / 中断 / 预算（ResumeResolution/InterruptCoordinator/BudgetManager；
// BudgetExceededError = 预算硬检查终止错误，属预算机制本模块）
export * from './core/recovery/index.js';
export * from './core/interrupt/interrupt.js';
export {
  BudgetExceededError,
  BudgetManager,
  BudgetRemaining,
  can_afford,
} from './core/budget/budget.js';
export type { BudgetPolicy, BudgetQuery } from './core/budget/budget.js';

// 结点契约（NodeContract/PathAssemblyConfig/QualityGate 等公开类型）
export * from './core/contracts/contracts.js';

// 角色槽模型配置解析（模型按角色槽配置/回落语义，CODING §8 锚点；宿主
// config 按槽解析模型配置形态并建链，不复制回落语义）
export {
  ROLE_AGENT,
  ROLE_ROUTER,
  build_role_model_chain,
  resolve_role_model,
} from './core/model_roles/index.js';
export type { RoleModelChain } from './core/model_roles/index.js';

// 自指契约工具三路声明（tool_wiring 配方组件：宿主只装配声明，机制不复制）
export { SELF_TOOL_CONTRACT } from './core/self_tools/index.js';
export { make_self_executor, operation_of, self_tool_specs } from './core/self_tools/index.js';
export type { SelfToolContext } from './core/self_tools/index.js';

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
} from './adapters/boot/index.js';

// 存储后端工厂（memory:// / sqlite:// 路由）
export * from './adapters/storage/index.js';

// LLM 协议注册（协议注册与协议适配器创建）
export {
  adapter_names,
  create_llm,
  get_adapter_class,
  register_adapter,
} from './adapters/llm/registry.js';
export type { LLMAdapterCtor } from './adapters/llm/registry.js';

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
} from './adapters/mcp/index.js';
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
} from './adapters/mcp/index.js';
export type { SpawnSeam as McpSpawnSeam } from './adapters/mcp/index.js';
