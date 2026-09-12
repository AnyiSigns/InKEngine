/**
 * 插件能力注册面：插件可贡献的注册类型集中声明口（计划 §4.2；PLUGINS.md §1 五面）。
 *
 * Dock.caps = 五面 tools / node_types / event_types / patch_kinds / ui_faces 的
 * 注册口径。本面收录前四面：tools（声明式工具端点/定义/执行体注册、工具编排打分
 * 选择）、node_types（引擎内置节点注册函数族，core/nodes 具名组）、event_types
 * （事件类型注册表 + 演化事件规格，含内联整组导出者）、patch_kinds（PATCH_KINDS/
 * PatchKind 词表，core/contracts/generated 数据面契约具名组）——各组语句（含分组
 * 注释）与 dock/index.ts 中对应语句逐字节一致：star 组整模块 star、具名组整语句
 * 具名，禁子集（防对公共符号做具名子集致公共面快照 value↔type 翻转），符号集合不
 * 因本面增减；index.ts 中语句保留，双路径导出按 name:kind 去重、快照不漂移。
 * ui_faces 面：数据面真源 ui_schema 归 view（§4.4 data 口径，已批），本面不重复
 * 收录。计划 §4.2 点名的 NodeTypeRegistry / HarnessRegistry / RetrieverRegistry
 * 三符号在现公共面无真源（不在 937 快照内），本轮不引入，推迟至其真正出口的
 * 波次（已批偏差，P3 卡认领）。
 */

// ── tools：声明式工具 + 工具编排 ──

// 声明式工具（端点注册表/工具定义/执行体注册/流水线/结点契约映射）
export * from '../core/declarative_tools/index.js';

// 工具编排与索引（WeightedToolScorer/ToolSelector/ToolVectorIndex）
export * from '../core/tool_orchestrator/tool_orchestrator.js';

// ── node_types：引擎内置节点注册面 ──

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

// ── event_types：事件类型注册表 + 演化事件规格 ──

export * from '../model/event_types/registry.js';
export * from '../model/event_types/eventTypeSpec.js';

// ── patch_kinds：数据面契约（值枚举 + 词表类型）──

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
