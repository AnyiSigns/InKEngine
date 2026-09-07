/**
 * 冷启动 base 候选构建（组装器私有辅助）。
 *
 * 组装在无算法/技能/草稿候选时按域 base 图模板（引擎内置池种子的数据形态）
 * 稳定产出合法候选：数据图模板经注册表重建并校验（池成员/目标覆盖/前缀
 * 可达），通过者保留原图数据形态（节点 config 如终态 role 随模板携带，不
 * 降级为类型链重建）；全链证据分排序 + beam top-k，与算法候选同口径收口。
 */

import { NodeContract } from '../contracts/contracts.js';
import { Graph } from '../graph/graph.js';
import type { StateSchema } from '../state/schema.js';
import type { NodeTypeRegistry } from '../registry/registry.js';
import { AssemblyCandidate } from './types.js';
import type { AssemblyRequest, BaseGraphsProvider } from './types.js';
import { CANDIDATE_SOURCE_BASE } from './constants.js';
import { validate_chain } from './validate.js';
import { _graph_chain } from './snapshot.js';

/** base 候选构建入参（组装器注入请求/池/约束与边评分）。 */
export interface _BaseCandidateOptions {
  provider: BaseGraphsProvider | null;
  request: AssemblyRequest;
  registry: NodeTypeRegistry;
  pool: Record<string, NodeContract>;
  goal_fields: readonly string[];
  max_safety_tier: number;
  state_schema: StateSchema | null;
  top_k: number;
  edge_score(src: string, dst: string): number;
}

/** 候选排序键（评分降序 → 链长升序 → 首结点名，确定性）。 */
function compareScored(
  a: { chain: readonly string[]; score: number },
  b: { chain: readonly string[]; score: number },
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.chain.length !== b.chain.length) return a.chain.length - b.chain.length;
  return a.chain[0]! < b.chain[0]! ? -1 : a.chain[0]! > b.chain[0]! ? 1 : 0;
}

/** 从域 base 图模板构建合法候选（无匹配/模板非法 = 空清单）。 */
export async function _base_candidates(options: _BaseCandidateOptions): Promise<AssemblyCandidate[]> {
  if (options.provider === null) return [];
  let graphs: readonly Record<string, unknown>[];
  try {
    graphs = await options.provider(options.request);
  } catch {
    return [];
  }
  const scored: Array<{ graph: Graph; chain: readonly string[]; score: number }> = [];
  for (const data of graphs) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    let graph: Graph;
    try {
      graph = Graph.from_dict(data as Record<string, unknown>, {
        registry: options.registry,
        validate: false,
      });
    } catch {
      continue;
    }
    const chain = _graph_chain(graph);
    const type_chain = chain
      .filter((name) => graph.node_bindings[name] !== undefined)
      .map((name) => graph.node_bindings[name]!.type_name);
    if (type_chain.length === 0) continue;
    const [ok] = validate_chain(type_chain, {
      pool: options.pool,
      goal_fields: options.goal_fields,
      entry_fields: options.request.entry_fields,
      max_safety_tier: options.max_safety_tier,
      state_schema: options.state_schema,
    });
    if (!ok) continue;
    let total = 0.0;
    for (let i = 0; i + 1 < type_chain.length; i++) {
      total += options.edge_score(type_chain[i]!, type_chain[i + 1]!);
    }
    const edges = Math.max(1, type_chain.length - 1);
    scored.push({ graph, chain: type_chain, score: total / edges });
  }
  scored.sort(compareScored);
  const top_k = Math.max(1, Math.trunc(options.top_k));
  return scored.slice(0, top_k).map(
    (item, rankIndex) =>
      new AssemblyCandidate({
        rank: rankIndex + 1,
        source: CANDIDATE_SOURCE_BASE,
        repaired: false,
        graph: item.graph,
        score: item.score,
      }),
  );
}
