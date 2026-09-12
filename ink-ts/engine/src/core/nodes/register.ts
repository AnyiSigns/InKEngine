/**
 * 引擎基础节点类型注册面（runtime/装配方复用）。
 *
 * register_engine_node_types：把池种子声明的基础类型注册进 GraphRegistries
 * （nodes 工厂 + 契约，edges 条件边），工厂闭包绑定 seams 盒——llm/工具
 * 流水线/工具表随引擎重建经 bind_engine_node_seams 刷新，节点执行时现取，
 * 使 dict 装载的数据图在引擎构造时即可按类型名解析执行体。perception 等
 * 引擎既有注册保持独立入口，调用方按需在装配处统一收进同一注册函数族。
 */

import { GraphRegistries } from '../registry/registry.js';
import { GraphDefinitionError } from '../../model/errors.js';
import type { NodeFactory } from '../registry/registry_types.js';
import {
  COND_LLM_FINISHED,
  COND_LLM_PENDING,
  STATE_PENDING,
  STATE_ROUTE_TO,
  TYPE_AGENT,
  TYPE_LLM_DECIDER,
  TYPE_ROUTER_JUDGE,
  TYPE_TOOL_PIPELINE,
  route_condition_name,
} from './constants.js';
import { agent_scope_contract, make_agent_factory } from './agent.js';
import { make_llm_decider_factory } from './llm_decider.js';
import { make_router_judge_factory } from './router.js';
import { make_tool_pipeline_factory } from './tool_pipeline.js';
import type { EngineNodeTypeSeed } from './pool_seed.js';
import {
  type EngineNodeSeams,
  type _EngineNodeSeamsBox,
  _bind_engine_node_seams,
  _seams_box_for,
} from './seams.js';

/** 引擎内置执行体构造器注册面（executor 名 → seams 盒 → 节点工厂）。
 *  executor 与实例类型键解耦：多个可区分实例（llm_planner/llm_reviewer/
 *  llm_main/router_plan_judge 等）可指向同一内核执行体（如 engine:llm_decider），
 *  实例分化落在 config（output_field/read_fields/routes）与实例契约。
 *  agent = kind=agent 实体收敛执行体（config 引用 entity_id，展开内部回路）。 */
const _ENGINE_EXECUTORS: Record<string, (box: _EngineNodeSeamsBox) => NodeFactory> = {
  [TYPE_LLM_DECIDER]: make_llm_decider_factory,
  [TYPE_TOOL_PIPELINE]: make_tool_pipeline_factory,
  [TYPE_ROUTER_JUDGE]: make_router_judge_factory,
  [TYPE_AGENT]: make_agent_factory,
};

/** 条件边判定：pending 通道是否有待执行工具清单。 */
function _pending_state(ctx: unknown): unknown {
  const anyCtx = ctx as { state?: unknown } | null;
  if (anyCtx === null || anyCtx === undefined || typeof anyCtx !== 'object') return undefined;
  const state = anyCtx.state;
  if (state === null || state === undefined || typeof state !== 'object' || Array.isArray(state)) {
    return undefined;
  }
  return (state as Record<string, unknown>)[STATE_PENDING];
}

function _pending_nonempty(ctx: unknown): boolean {
  const raw = _pending_state(ctx);
  return Array.isArray(raw) && raw.length > 0;
}

/** route:<key> 判定：state[STATE_ROUTE_TO] 是否等于本条件声明的走向 key。 */
function _route_matches(ctx: unknown, key: string): boolean {
  const anyCtx = ctx as { state?: unknown } | null;
  if (anyCtx === null || anyCtx === undefined || typeof anyCtx !== 'object') return false;
  const state = anyCtx.state;
  if (state === null || state === undefined || typeof state !== 'object' || Array.isArray(state)) {
    return false;
  }
  return (state as Record<string, unknown>)[STATE_ROUTE_TO] === key;
}

/** route 走向 key 合法性（注册面防御：空 key / 含前缀分隔符的 key 拒绝——
 *  保证 `route:<key>` 条件名与 key 后缀一一对应）。 */
function _validate_route_key(key: unknown, at: string): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new GraphDefinitionError(`route 条件 key 不能为空（${at}）`);
  }
  if (key.includes(':')) {
    throw new GraphDefinitionError(`route 条件 key 不能含 ':'（${at}）`);
  }
  return key;
}

/** 登记单个 route 走向条件边（幂等：已登记跳过；key 非法抛 GraphDefinitionError）。 */
export function register_route_edge_condition(registries: GraphRegistries, key: string): void {
  const valid = _validate_route_key(key, 'register_route_edge_condition');
  const name = route_condition_name(valid);
  if (registries.edges.has(name)) return;
  registries.edges.register(name, (ctx) => _route_matches(ctx, valid));
}

/** 登记 route:<key> 条件边族（供「router → [目标A 条件 route:A / 目标B 条件
 *  route:B]」静态出边分支的声明式图数据解析；key 清单非法任一 = 抛错拒绝）。 */
export function register_route_edge_conditions(registries: GraphRegistries, keys: readonly string[]): void {
  for (const key of keys) {
    register_route_edge_condition(registries, key);
  }
}

/** 该 executor 名是否有引擎内置执行体构建器（声明式登记恢复的解析前提）。 */
export function has_engine_executor(executor: string): boolean {
  return _ENGINE_EXECUTORS[executor] !== undefined;
}

/** 旧语义兼容：类型名即执行体名（无解耦的既有引擎内置类型按名自绑）。 */
export function has_engine_node_type(type_name: string): boolean {
  return has_engine_executor(type_name);
}

/** 登记单个引擎内置执行体节点（已登记 = 跳过；未知 executor = false）。
 *  供声明式注册表恢复：type_name 是实例键、executor 是内核名（缺省 =
 *  type_name 自身——既有形态零变化）。 */
export function register_engine_node_type(
  registries: GraphRegistries,
  type_name: string,
  contract: import('../../model/contracts/contracts.js').NodeContract | null,
  seams: EngineNodeSeams | null = null,
  executor: string = type_name,
): boolean {
  const builder = _ENGINE_EXECUTORS[executor];
  if (builder === undefined) return false;
  if (!registries.nodes.has(type_name)) {
    const box = _seams_box_for(registries.nodes, seams);
    registries.nodes.register(
      type_name,
      builder(box),
      contract === null ? undefined : contract,
    );
  }
  return true;
}

/** 登记引擎内置回环条件边（幂等：已登记跳过）。 */
export function register_engine_edge_conditions(registries: GraphRegistries): void {
  if (!registries.edges.has(COND_LLM_PENDING)) {
    registries.edges.register(COND_LLM_PENDING, _pending_nonempty);
  }
  if (!registries.edges.has(COND_LLM_FINISHED)) {
    registries.edges.register(COND_LLM_FINISHED, (ctx) => !_pending_nonempty(ctx));
  }
}

/**
 * 登记引擎内置执行体节点 + 回环条件边（幂等：已登记类型/条件跳过）。
 *
 * @param registries 建图注册表捆绑（nodes 注册工厂 + 契约；edges 注册条件边）。
 * @param seeds 池种子节点实例声明（seed.type = 实例键；seed.executor 缺省 =
 *   type 自身；未知 executor 声明跳过——该执行体由自身注册面登记）。
 * @param seams 初始 seams（缺省空 = 无模型/无流水线确定性 stub）。
 */
export function register_engine_node_types(
  registries: GraphRegistries,
  seeds: readonly EngineNodeTypeSeed[],
  seams: EngineNodeSeams | null = null,
): void {
  const box = _seams_box_for(registries.nodes, seams);
  for (const seed of seeds) {
    const builder = _ENGINE_EXECUTORS[seed.executor ?? seed.type];
    if (builder === undefined) continue;
    if (!registries.nodes.has(seed.type)) {
      registries.nodes.register(seed.type, builder(box), seed.contract);
    }
  }
  register_engine_edge_conditions(registries);
}

/** 刷新引擎内置节点绑定的实时 seams（引擎重建处调用；类型未注册 = 跳过）。 */
export function bind_engine_node_seams(registries: GraphRegistries, seams: EngineNodeSeams): void {
  _bind_engine_node_seams(registries.nodes, seams);
}

/**
 * 登记 agent 执行体结点类型（kind=agent 实体收敛执行形态的登记入口）。
 *
 * 图内 agent 结点 = 结构声明：登记的类型名可引用任意实体（实例化在图形
 * 绑定 config 携带 entity_id；本登记只装执行体，不做实体绑定）。主机按需
 * 登记实体别名实例（type_name = `agent:<entity_id>`）或通用键（缺省
 * TYPE_AGENT）。重复登记幂等跳过；已登记的类型不重复覆盖。
 */
export function register_agent_node_type(
  registries: GraphRegistries,
  init: {
    type_name?: string | null;
    contract?: import('../../model/contracts/contracts.js').NodeContract | null;
  } = {},
): boolean {
  const type_name = init.type_name ?? TYPE_AGENT;
  const builder = _ENGINE_EXECUTORS[TYPE_AGENT];
  if (builder === undefined) return false;
  if (!registries.nodes.has(type_name)) {
    const box = _seams_box_for(registries.nodes, null);
    registries.nodes.register(
      type_name,
      builder(box),
      init.contract ?? agent_scope_contract(),
    );
  }
  return true;
}

export type { EngineNodeSeams };
