/**
 * core/nodes 公开面：引擎内置基础节点类型（llm_decider/tool_pipeline）的
 * 注册面 + 池种子数据 + 声明式常量。
 *
 * 引擎给多宿主用：基础可执行节点类型由引擎 core 内置注册，宿主只给数据
 * （数据图按类型名引用即解析执行）。注册面供 runtime/装配方复用；工厂与
 * seams 绑定细节（_ 前缀内部模块）不随公共面外泄。
 */

export {
  COND_LLM_FINISHED,
  COND_LLM_PENDING,
  ENGINE_DEFAULT_TOOL_ROUNDS,
  ENGINE_STUB_REPLY,
  ROLE_TERMINAL,
  STATE_MESSAGES,
  STATE_PENDING,
  STATE_REPLY,
  STATE_RESULTS,
  STATE_STEP_ARGS,
  STATE_TOOL_ROUNDS,
  TYPE_LLM_DECIDER,
  TYPE_TOOL_PIPELINE,
} from './constants.js';
export {
  bind_engine_node_seams,
  has_engine_node_type,
  register_engine_edge_conditions,
  register_engine_node_type,
  register_engine_node_types,
} from './register.js';
export type { EngineNodeSeams } from './register.js';
export {
  default_engine_pool_seed,
} from './pool_seed.js';
export type {
  EngineDomainSeed,
  EngineNodeTypeSeed,
  EnginePoolSeed,
} from './pool_seed.js';
