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
import type { NodeFactory } from '../registry/registry_types.js';
import {
  COND_LLM_FINISHED,
  COND_LLM_PENDING,
  STATE_PENDING,
  TYPE_LLM_DECIDER,
  TYPE_TOOL_PIPELINE,
} from './constants.js';
import { make_llm_decider_factory } from './llm_decider.js';
import { make_tool_pipeline_factory } from './tool_pipeline.js';
import type { EngineNodeTypeSeed } from './pool_seed.js';
import {
  type EngineNodeSeams,
  type _EngineNodeSeamsBox,
  _bind_engine_node_seams,
  _seams_box_for,
} from './seams.js';

/** 引擎内置基础节点类型名 → 工厂构造器（seams 盒 → 节点工厂）。 */
const _ENGINE_NODE_FACTORIES: Record<string, (box: _EngineNodeSeamsBox) => NodeFactory> = {
  [TYPE_LLM_DECIDER]: make_llm_decider_factory,
  [TYPE_TOOL_PIPELINE]: make_tool_pipeline_factory,
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

/** 该类型是否有引擎内置执行体构建器（声明式登记恢复的解析前提）。 */
export function has_engine_node_type(type_name: string): boolean {
  return _ENGINE_NODE_FACTORIES[type_name] !== undefined;
}

/** 登记单个引擎内置基础节点类型（已登记 = 跳过；未知内置类型 = false）。
 *  供声明式注册表恢复（按登记行的 executor 绑定名解析执行体）。 */
export function register_engine_node_type(
  registries: GraphRegistries,
  type_name: string,
  contract: import('../contracts/contracts.js').NodeContract | null,
  seams: EngineNodeSeams | null = null,
): boolean {
  const builder = _ENGINE_NODE_FACTORIES[type_name];
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
 * 登记引擎内置基础节点类型 + 回环条件边（幂等：已登记类型/条件跳过）。
 *
 * @param registries 建图注册表捆绑（nodes 注册工厂 + 契约；edges 注册条件边）。
 * @param seeds 池种子节点声明（未知类型声明跳过——该类型由自身注册面登记）。
 * @param seams 初始 seams（缺省空 = 无模型/无流水线确定性 stub）。
 */
export function register_engine_node_types(
  registries: GraphRegistries,
  seeds: readonly EngineNodeTypeSeed[],
  seams: EngineNodeSeams | null = null,
): void {
  const box = _seams_box_for(registries.nodes, seams);
  for (const seed of seeds) {
    const builder = _ENGINE_NODE_FACTORIES[seed.type];
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
export type { EngineNodeSeams };
