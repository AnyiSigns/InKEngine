/**
 * 图节点装配通道（S1-b2）：plugins 真源声明 → hosts/lib 出厂装配。
 *
 * 引擎保持不依赖插件，节点执行体装配槽（register_node_builder，S1-a）由
 * 本模块按 graph_nodes 声明清单接入：清单声明的每个内核名若引擎出厂槽已持有
 * （当前 llm_decider/router_judge/tool_pipeline/agent 四内核仍在引擎）则不动，
 * 未持有时由装配方经 builderFor 注入插件实现——同一份通道，过渡期零注入、
 * 迁移后零改动。graphNodeKernelReport 提供清单 → 引擎可解析覆盖对账，防
 * 「清单声明了内核名但运行时无名可解析」的漂移。
 */

import {
  has_engine_executor,
  register_node_builder,
} from '@ink-ts/engine';
import type {
  EngineNodeTypeSeed,
  EnginePoolSeed,
} from '@ink-ts/engine';
import {
  GRAPH_NODE_DECLS,
  graphNodeKernels,
  type GraphNodeDecl,
} from '../assembly/graph_nodes.generated.js';

/** 引擎节点执行体构造器签名（经公共面 register_node_builder 参数推导，不触私有 seams 类型）。 */
export type GraphNodeBuilder = Parameters<typeof register_node_builder>[1];

/** 清单 → 引擎可解析覆盖对账报告。 */
export type GraphNodeKernelReport = {
  /** 清单声明条数（plugins/graph_nodes 插件数）。 */
  total: number;
  /** 清单声明的唯一内核名集合（去重保序）。 */
  unique: readonly string[];
  /** 有引擎可解析执行体（引擎出厂槽持有，无需注入）的内核名。 */
  resolvable: readonly string[];
  /** 引擎不可解析（需经注入位由装配方补齐）的内核名。 */
  missing: readonly string[];
};

/** 清单 → 注入报告。 */
export type InjectReport = {
  /** 本次经装配槽补入（引擎未持有、注入成功）的内核名。 */
  injected: string[];
  /** 引擎出厂槽已持有、跳过注入的内核名。 */
  engineHeld: string[];
};

/** 清单声明 vs 引擎可解析的对账：missing 应为空（引擎出厂槽持有期内）或
 *  恰等于装配方即将注入的缺失集。 */
export function graphNodeKernelReport(): GraphNodeKernelReport {
  const unique = graphNodeKernels();
  const resolvable = unique.filter((name) => has_engine_executor(name));
  const missing = unique.filter((name) => !has_engine_executor(name));
  return { total: GRAPH_NODE_DECLS.length, unique, resolvable, missing };
}

/** 接入装配槽：引擎未持有的清单内核名经 builderFor 注入插件实现（引擎持有
 *  即跳过，幂等）。过渡期引擎全持有 → 零注入；迁移期缺失内核在此补齐。 */
export function injectGraphNodeBuilders(
  builderFor: (executor: string) => GraphNodeBuilder | null,
): InjectReport {
  const injection: InjectReport = { injected: [], engineHeld: [] };
  for (const name of graphNodeKernels()) {
    if (has_engine_executor(name)) {
      injection.engineHeld.push(name);
      continue;
    }
    const builder = builderFor(name);
    if (builder === null) {
      throw new Error(`图节点声明缺失内核实现：${name}`);
    }
    if (register_node_builder(name, builder)) {
      injection.injected.push(name);
    }
  }
  return injection;
}

/** 清单声明 → 引擎池种子（S1-b2 装配权威迁移：节点实例构图声明落 plugins
 *  真源，engine 出厂 default 与之对齐锁之，退役前双源结构面一致）。 */
function _declToSeed(decl: GraphNodeDecl): EngineNodeTypeSeed {
  return {
    type: decl.type,
    executor: decl.executor,
    kind: decl.kind ?? undefined,
    label: decl.label ?? undefined,
    description: decl.description ?? undefined,
    flags: decl.flags ?? undefined,
    default_config: decl.config_defaults,
    contract: (decl.contract as unknown) as EngineNodeTypeSeed['contract'],
  };
}

/** 完整清单池种子（8 条，含 agent 实体——与 register_agent_node_type 同体装配面）。 */
export function graphNodeInstanceSeeds(): EnginePoolSeed {
  return {
    enabled: true,
    node_types: GRAPH_NODE_DECLS.map(_declToSeed),
  };
}

/** 装配注入面池种子（非 agent 7 条：agent 执行体走 register_agent_node_type
 *  专用入口，不入池——与 engine 出厂 default_engine_pool_seed() 结构面对齐）。 */
export function graphNodeAssemblySeed(): EnginePoolSeed {
  return {
    enabled: true,
    node_types: GRAPH_NODE_DECLS.filter((decl) => decl.type !== 'agent').map(_declToSeed),
  };
}

/** 装配权威一致性 lock：清单非 agent 7 条与引擎出厂默认结构面对齐（type
 *  集合逐条相等；contract 不比——装配面幂等再派生，实例契约随 config 派生）。
 *  任一漂移抛错，防『插件真源声明与引擎出厂节点两轨分化』。 */
export function assertGraphNodeSeedsAligned(engineDefault: EnginePoolSeed): void {
  const decls = graphNodeAssemblySeed().node_types;
  const defs = engineDefault.node_types;
  const declTypes = new Set(decls.map((seed) => seed.type));
  const defTypes = new Set(defs.map((seed) => seed.type));
  const drift: string[] = [];
  for (const type of defTypes) {
    if (!declTypes.has(type)) drift.push(`引擎出厂多出清单未声明类型：${type}`);
  }
  for (const type of declTypes) {
    if (!defTypes.has(type)) drift.push(`清单声明引擎出厂缺失类型：${type}`);
  }
  if (drift.length > 0) throw new Error(`图节点装配池与引擎出厂池类型集漂移：${drift.join('；')}`);
  const defByType = new Map(defs.map((seed) => [seed.type, seed]));
  for (const seed of decls) {
    const def = defByType.get(seed.type);
    if (def === undefined) continue;
    const declExec = seed.executor ?? seed.type;
    const defExec = def.executor ?? def.type;
    if (declExec !== defExec) {
      drift.push(`${seed.type}：executor 清单 ${declExec} ≠ 引擎出厂 ${defExec}`);
    }
    const declCfg = JSON.stringify(seed.default_config ?? {});
    const defCfg = JSON.stringify(def.default_config ?? {});
    if (declCfg !== defCfg) drift.push(`${seed.type}：config_defaults 漂移（清单 ${declCfg} ≠ 出厂 ${defCfg}）`);
  }
  if (drift.length > 0) throw new Error(`图节点装配池与引擎出厂池漂移：${drift.join('；')}`);
}