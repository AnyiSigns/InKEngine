/**
 * core/nodes 公开面：引擎内置基础节点类型（llm_decider/tool_pipeline/
 * router_judge 及其可区分实例 llm_planner/llm_reviewer/llm_main/
 * router_plan_judge）的注册面 + 池种子数据 + 声明式常量 + 实例契约派生 +
 * llm 字段 I/O 约定 + 出厂边先验。
 *
 * 引擎给多宿主用：基础可执行节点类型由引擎 core 内置注册，宿主只给数据
 * （数据图按类型名引用即解析执行）。注册面供 runtime/装配方复用；工厂与
 * seams 绑定细节（_ 前缀内部模块）不随公共面外泄。
 */

export {
  CFG_OUTPUT_FIELD,
  CFG_READ_FIELDS,
  LLM_OUTPUT_RESERVED_KEYS,
  build_read_projection,
  config_read_fields,
  is_reserved_output_key,
  llm_output_key,
  parse_output_field_key,
} from './field_io.js';
export { derive_instance_contract } from './instance_contract.js';
export {
  COND_LLM_FINISHED,
  COND_LLM_PENDING,
  COND_ROUTE_PREFIX,
  ENGINE_DEFAULT_TOOL_ROUNDS,
  ENGINE_STUB_REPLY,
  ROLE_TERMINAL,
  STATE_DISPLAY_MESSAGES,
  STATE_DISPLAY_SEQ,
  STATE_MESSAGES,
  STATE_PENDING,
  STATE_PLAN,
  STATE_REPLY,
  STATE_RESULTS,
  STATE_REVIEW,
  STATE_ROUTE_TO,
  STATE_STEP_ARGS,
  STATE_TOOL_ROUNDS,
  TYPE_AGENT,
  TYPE_LLM_DECIDER,
  TYPE_LLM_MAIN,
  TYPE_LLM_PLANNER,
  TYPE_LLM_REVIEWER,
  TYPE_ROUTER_JUDGE,
  TYPE_ROUTER_PLAN_JUDGE,
  TYPE_TOOL_PIPELINE,
  route_condition_name,
} from './constants.js';
export {
  bind_engine_node_seams,
  has_engine_executor,
  has_engine_node_type,
  register_agent_node_type,
  register_engine_edge_conditions,
  register_engine_node_type,
  register_engine_node_types,
  register_route_edge_condition,
  register_route_edge_conditions,
} from './register.js';
export { agent_scope_contract } from './agent.js';
export type { EngineNodeSeams } from './register.js';
export {
  default_engine_pool_seed,
  default_engine_seed_edges,
} from './pool_seed.js';
export type {
  EngineNodeTypeSeed,
  EnginePoolSeed,
} from './pool_seed.js';
