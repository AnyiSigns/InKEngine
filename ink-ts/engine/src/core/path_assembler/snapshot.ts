/**
 * 组装器私有纯辅助（快照行 ↔ 边证据、图链还原、证据索引、链级证据聚合）。
 *
 * 从 path_assembler.py 组装器内私有函数/静态方法提炼：与具体组装流程解耦，
 * 供缓存命中构造（_result_from_cache）、顶替评分、多径信号判据（ENG9a-22，
 * multipath.chain_evidence 同源聚合——multipath 模块未迁移前按同式就地实现）
 * 与图定义数据链序还原复用。
 */

import { DEFAULT_CONTRACT_VERSION, edge_evidence_from_dict } from '../edge_evidence/index.js';
import type { EdgeEvidence, EdgeKey } from '../edge_evidence/index.js';
import type { FingerprintCacheEntry } from '../fingerprint_cache/index.js';
import type { Graph } from '../graph/graph.js';
import type { AssemblyCandidate, EdgeIndexKey } from './types.js';

/** 快照行 → 边证据（按类型对匹配；未命中 = 零证据先验下界）。
 *  匹配口径 = 类型级（variant_hash 空）：变体专属证据不参与缓存路径评分。 */
export function _snapshot_edge(
  rows: readonly Record<string, unknown>[],
  src: string,
  dst: string,
): EdgeEvidence | null {
  for (const row of rows) {
    if (
      String(row['variant_hash'] ?? '') === '' &&
      row['src_type'] === src &&
      row['dst_type'] === dst
    ) {
      return edge_evidence_from_dict(row);
    }
  }
  return null;
}

/** 域内证据行 → 内存索引（ENG9a-16：与缓存证据快照共用同一构造）。
 *  索引键 5 元组 = (src_type, dst_type, src/dst 契约版本, variant_hash)；
 *  只收类型级行（variant_hash 空），变体专属证据不混入类型级评分。 */
export function _evidence_index_from_rows(
  rows: readonly EdgeEvidence[],
): Map<string, EdgeEvidence> {
  const index = new Map<string, EdgeEvidence>();
  for (const row of rows) {
    if (row.key.variant_hash !== '') continue;
    index.set(edge_index_key(row.key).join('\u0000'), row);
  }
  return index;
}

/** 边证据 key → 组装侧 5 元索引键（variant_hash 恒空归类型级）。 */
export function edge_index_key(key: EdgeKey): EdgeIndexKey {
  return [
    key.src_type,
    key.dst_type,
    key.src_contract_version,
    key.dst_contract_version,
    key.variant_hash,
  ];
}

/** 线性链图 → 节点名序（入口起沿边走；图定义数据序列化不保节点序，
 *  命中重建后必须按结构还原链序——评分/展示依赖链序）。 */
export function _graph_chain(graph: Graph): readonly string[] {
  const chain: string[] = [];
  let current: string | null = graph.entry;
  for (let i = 0; i < Object.keys(graph.node_bindings).length; i++) {
    if (current === null || chain.includes(current)) break;
    chain.push(current);
    const nexts: readonly { target: string }[] | undefined = graph.edges[current];
    if (nexts === undefined || nexts.length === 0) break;
    current = nexts[0]!.target;
  }
  return chain;
}

/** 把绑定字典重排为链序（图定义数据的绑定插入序与链序对齐）。 */
export function reorder_bindings_to_chain(graph: Graph, chain: readonly string[]): void {
  const bindings = graph.node_bindings;
  const ordered: Record<string, (typeof bindings)[string]> = {};
  for (const name of chain) {
    if (bindings[name] === undefined) continue;
    ordered[name] = bindings[name];
  }
  for (const name of Object.keys(bindings)) delete bindings[name];
  for (const name of Object.keys(ordered)) bindings[name] = ordered[name]!;
}

/** 缓存路径类型链（入口起沿边走还原链序；退化条目仅携指纹 = 空链）。 */
export function _cached_chain_of(entry: FingerprintCacheEntry): readonly string[] {
  const path = entry.path ?? {};
  const nodes = path['nodes'];
  const edges = path['edges'];
  const start = path['entry'];
  if (
    nodes === null || typeof nodes !== 'object' || Array.isArray(nodes) ||
    edges === null || typeof edges !== 'object' || Array.isArray(edges)
  ) {
    return [];
  }
  const nodeTable = nodes as Record<string, unknown>;
  const edgeTable = edges as Record<string, unknown>;
  const chain: string[] = [];
  let current: string | null = typeof start === 'string' ? start : null;
  for (let i = 0; i < Object.keys(nodeTable).length; i++) {
    if (current === null) break;
    const spec = nodeTable[current];
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) break;
    const type = (spec as Record<string, unknown>)['type'];
    chain.push(typeof type === 'string' ? type : current);
    const edgeList = edgeTable[current];
    const target =
      Array.isArray(edgeList) && edgeList.length > 0 && typeof edgeList[0] === 'object'
        ? (edgeList[0] as Record<string, unknown>)['target']
        : null;
    if (typeof target !== 'string' || chain.includes(target)) break;
    current = target;
  }
  return chain;
}

/** 类型级证据索引投影：5 元组装索引（variant_hash 恒空）→ 4 元口径索引，
 *  multipath 汇流/信号判据同源口径（src/dst/契约版本对）。 */
export function type_level_index_of(
  evidence_index: Map<string, EdgeEvidence>,
): Map<string, EdgeEvidence> {
  const index = new Map<string, EdgeEvidence>();
  for (const [key, row] of evidence_index) {
    const parts = key.split('\u0000');
    index.set(parts.slice(0, 4).join('\u0000'), row);
  }
  return index;
}

/** 候选链全链证据聚合（multipath.chain_evidence 同源：索引内一次枚举；
 *  无命中边 = 零证据口径，不计入成败样本）。 */
export function chain_evidence_aggregate(
  candidate: AssemblyCandidate,
  type_level_index: Map<string, EdgeEvidence>,
): { edges: number; evidenced: number; success_total: number; fail_total: number; cost_total: number } {
  let edges = 0;
  let evidenced = 0;
  let success = 0;
  let fail = 0;
  let cost = 0.0;
  const bindings = candidate.graph.node_bindings;
  const chain = candidate.chain;
  for (let i = 0; i + 1 < chain.length; i++) {
    const src = chain[i]!;
    const dst = chain[i + 1]!;
    edges += 1;
    const srcBinding = bindings[src];
    const dstBinding = bindings[dst];
    const srcVersion =
      srcBinding?.contract !== null && srcBinding !== undefined && srcBinding.contract !== null
        ? String(srcBinding.contract.version)
        : DEFAULT_CONTRACT_VERSION;
    const dstVersion =
      dstBinding !== undefined && dstBinding.contract !== null
        ? String(dstBinding.contract.version)
        : DEFAULT_CONTRACT_VERSION;
    const key = [src, dst, srcVersion, dstVersion].join('\u0000');
    const row = type_level_index.get(key);
    if (row === undefined) continue;
    evidenced += 1;
    success += row.success_count;
    fail += row.fail_count;
    cost += row.avg_cost;
  }
  return { edges, evidenced, success_total: success, fail_total: fail, cost_total: cost };
}

/** 契约版本取串（绑定缺契约 = 缺省版本；与缓存/快照口径一致）。 */
export function contract_version_of(contract: { version: number } | null | undefined): string {
  if (contract === null || contract === undefined) return DEFAULT_CONTRACT_VERSION;
  return String(contract.version);
}
