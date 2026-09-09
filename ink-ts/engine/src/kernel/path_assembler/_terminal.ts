/**
 * 终态候选兜底构建（组装器私有辅助）。
 *
 * 组装在无算法/技能/证据候选时的兜底 = 从池选 flags.terminal=true 的 active
 * 终态类型出**单节点图**（entry=exit=该类型，0 边）——最小可行回合形态，
 * 不回落任何整图模板。候选须过合法校验（池成员/目标覆盖/前缀可达），通过者
 * 按终态类型清单顺序 + top_k 产出；取不到任何可自终止终态候选 = 空清单
 * （组装器显式“无候选”，不臆造图）。
 */

import { NodeContract } from '../../core/contracts/contracts.js';
import { Graph } from '../../core/graph/graph.js';
import type { StateSchema } from '../../core/state/schema.js';
import { AssemblyCandidate } from './types.js';
import type { AssemblyRequest, TerminalTypesProvider } from './types.js';
import { CANDIDATE_SOURCE_TERMINAL } from './constants.js';
import { validate_chain } from './validate.js';

/** 终态兜底候选构建入参（组装器注入请求/池/约束）。 */
export interface _TerminalCandidateOptions {
  provider: TerminalTypesProvider | null;
  request: AssemblyRequest;
  pool: Record<string, NodeContract>;
  goal_fields: readonly string[];
  entry_fields: readonly string[];
  max_safety_tier: number;
  state_schema: StateSchema | null;
  top_k: number;
  /** 池实例缺省 config（单节点图绑定实例 config；缺省 {} = 零 config）。 */
  instance_configs?: Record<string, Record<string, unknown>> | null;
}

/** 从池选终态候选出单节点图（无可用终态候选/无合法候选 = 空清单）。 */
export async function _terminal_candidates(
  options: _TerminalCandidateOptions,
): Promise<AssemblyCandidate[]> {
  if (options.provider === null) return [];
  let terminal_types: readonly string[];
  try {
    terminal_types = await options.provider(options.request);
  } catch {
    return [];
  }
  const configs = options.instance_configs ?? {};
  const candidates: AssemblyCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of terminal_types) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const contract = options.pool[raw];
    if (contract === undefined) continue; // 未入组装池（无契约/未注册）不入候选
    const [ok] = validate_chain([raw], {
      pool: options.pool,
      goal_fields: options.goal_fields,
      entry_fields: options.entry_fields,
      max_safety_tier: options.max_safety_tier,
      state_schema: options.state_schema,
    });
    if (!ok) continue;
    const graph = new Graph({
      name: options.request.graph_name ?? `assembly.${options.request.domain}`,
      entry: raw,
    });
    graph.add_node_type(raw, raw, { ...(configs[raw] ?? {}) }, contract);
    graph.add_exit(raw);
    candidates.push(
      new AssemblyCandidate({
        rank: candidates.length + 1,
        source: CANDIDATE_SOURCE_TERMINAL,
        repaired: false,
        graph,
        score: 0.0,
      }),
    );
    if (candidates.length >= Math.max(1, Math.trunc(options.top_k))) break;
  }
  return candidates;
}
