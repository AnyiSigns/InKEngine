/**
 * 正向链式（前缀可达性）beam 搜索（path_assembler.py「schema 反推纯算法」段移植）。
 *
 * 从入口字段出发逐层扩边至目标覆盖；多源汇聚合法（必填输入 ⊆ 入口 ∪ 前缀
 * 产出并集）；防发散（只扩展产出新增的结点）；防重复（路径内不重复、无环）；
 * 安全档扩展期即剪枝。Beam 排序 = 目标相关度优先（已覆盖 ∩ 目标字段数降序）→
 * 末边证据分 → 路径长度升序 → 末结点名字典序（实验定稿：贪婪全量覆盖排序
 * 会把可并行分支在第 3 层挤出 beam）。
 */

import { DEFAULT_BEAM_WIDTH, DEFAULT_MAX_PATH_LENGTH, DEFAULT_MAX_SAFETY_TIER, STATS_BEAM_EXTENSIONS } from './constants.js';
import type { NodeContract } from '../contracts/contracts.js';
import { _build_contract_views, _ContractView } from './validate.js';

/** 正向链式（前缀可达性）beam 搜索：从入口字段出发逐层扩边至目标覆盖。 */
export function _forward_search(
  goal_fields: readonly string[],
  entry_fields: readonly string[],
  pool: Record<string, NodeContract>,
  opts: {
    beam_width?: number;
    max_depth?: number;
    max_safety_tier?: number;
    exclude?: readonly string[];
    edge_score_lookup?: ((src: string, dst: string) => number) | null;
    stats?: Record<string, number> | null;
    views?: Record<string, _ContractView> | null;
  } = {},
): readonly (readonly string[])[] {
  const views = opts.views ?? undefined;
  const viewTable: Record<string, _ContractView> = views ?? _build_contract_views(pool);
  const goal = new Set(goal_fields);
  const found: (readonly string[])[] = [];
  const seen_found = new Set<string>();
  const beam = Math.max(1, Math.trunc(opts.beam_width ?? DEFAULT_BEAM_WIDTH));
  const depth = Math.max(1, Math.trunc(opts.max_depth ?? DEFAULT_MAX_PATH_LENGTH));
  const exclude_set = new Set(opts.exclude ?? []);
  const max_safety_tier = opts.max_safety_tier ?? DEFAULT_MAX_SAFETY_TIER;

  // 候选形态：(链, 已覆盖字段集, 末边证据分)
  const entryCovered = new Set(entry_fields);
  type Candidate = { path: readonly string[]; covered: ReadonlySet<string>; lastScore: number };
  let candidates: Candidate[] = [{ path: [], covered: entryCovered, lastScore: 0.0 }];
  const visited = new Set<string>();

  for (let round = 0; round < depth; round++) {
    if (candidates.length === 0) break;
    const nxt: Candidate[] = [];
    for (const cand of candidates) {
      const key = `${cand.path.join('\u0000')}\u0001${[...cand.covered].sort().join('\u0000')}`;
      if (visited.has(key)) continue;
      visited.add(key);
      for (const type_name of Object.keys(viewTable)) {
        if (exclude_set.has(type_name) || cand.path.includes(type_name)) continue;
        const view = viewTable[type_name]!;
        if (view.contract.safety_tier > max_safety_tier) continue; // 安全档剪枝
        if (!subsetOf(view.required, cand.covered)) continue;
        if (cand.path.length > 0 && subsetOf(view.required, entryCovered)) {
          // 根结点剪枝：入口字段即满足的结点只作链首
          continue;
        }
        const produced = view.produced;
        let hasNew = false;
        for (const name of produced) {
          if (!cand.covered.has(name)) {
            hasNew = true;
            break;
          }
        }
        if (!hasNew) continue; // 无新增产出的结点跳过（防发散）
        const new_covered = new Set(cand.covered);
        for (const name of produced) new_covered.add(name);
        const new_path = [...cand.path, type_name];
        let goalCovered = true;
        for (const g of goal) {
          if (!new_covered.has(g)) {
            goalCovered = false;
            break;
          }
        }
        if (goalCovered) {
          const foundKey = new_path.join('\u0000');
          if (!seen_found.has(foundKey)) {
            seen_found.add(foundKey);
            found.push(new_path);
          }
          continue; // 已解出目标，不再扩展
        }
        let last = 0.0;
        if (cand.path.length > 0 && opts.edge_score_lookup !== null && opts.edge_score_lookup !== undefined) {
          last = opts.edge_score_lookup(cand.path[cand.path.length - 1]!, type_name);
        }
        nxt.push({ path: new_path, covered: new_covered, lastScore: last });
      }
    }
    if (nxt.length === 0) break;
    // 排序：目标相关度优先 → 末边证据分 → 深度 → 末结点名（确定性）
    nxt.sort((a, b) => {
      const relA = overlap(a.covered, goal);
      const relB = overlap(b.covered, goal);
      if (relA !== relB) return relB - relA;
      if (a.lastScore !== b.lastScore) return b.lastScore - a.lastScore;
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      const tailA = a.path[a.path.length - 1]!;
      const tailB = b.path[b.path.length - 1]!;
      return tailA < tailB ? -1 : tailA > tailB ? 1 : 0;
    });
    candidates = nxt.slice(0, beam);
    if (opts.stats !== null && opts.stats !== undefined) {
      opts.stats[STATS_BEAM_EXTENSIONS] = (opts.stats[STATS_BEAM_EXTENSIONS] ?? 0) + nxt.length;
    }
  }
  return found;
}

/** required ⊆ covered 判定。 */
function subsetOf(required: ReadonlySet<string>, covered: ReadonlySet<string>): boolean {
  for (const name of required) {
    if (!covered.has(name)) return false;
  }
  return true;
}

/** covered ∩ goal 计数（目标相关度）。 */
function overlap(covered: ReadonlySet<string>, goal: Set<string>): number {
  let count = 0;
  for (const name of goal) {
    if (covered.has(name)) count += 1;
  }
  return count;
}
