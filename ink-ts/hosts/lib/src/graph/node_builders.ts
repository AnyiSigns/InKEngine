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
import {
  GRAPH_NODE_DECLS,
  graphNodeKernels,
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