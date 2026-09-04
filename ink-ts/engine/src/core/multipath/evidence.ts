/**
 * 候选链证据口径（multipath.py 证据段移植，1:1）。
 *
 * ChainEvidence = 一条候选链的边证据聚合口径（纯算法；按域分组后逐链
 * 汇总，档位由 derive_edge_tier 同源公式推导）；EdgeRef = 链内一条边
 * （类型 + 契约版本引用，证据入口键）；chain_edge_refs / chain_terminal_fields
 * / chain_evidence / evidence_index_of = 候选链 → 边引用 → 域内聚合 的
 * 全链路纯函数（内存索引内一次枚举；无命中 = 零证据口径）。
 *
 * 证据索引口径 = 类型级（variant_hash 空）：变体专属证据不参与类型级
 * 聚合；同类型对多变体行不互相覆盖。索引键 4 元组
 * (src_type, dst_type, src_contract_version, dst_contract_version) 与
 * 组装侧快照（snapshot.ts type_level_index_of）同源口径。
 */

import { DEFAULT_CONTRACT_VERSION } from '../edge_evidence/index.js';
import type { EdgeEvidence, EdgeKey } from '../edge_evidence/index.js';
import { derive_edge_tier } from '../edge_evidence/index.js';
import { produced_field_names } from '../link_validator/link_validator.js';
import type { AssemblyCandidate } from '../path_assembler/types.js';

/** 域内证据行 → 内存索引键（4 元口径，\u0000 分隔防串键）。 */
function index_key(
  src: string,
  dst: string,
  src_version: string,
  dst_version: string,
): string {
  return [src, dst, src_version, dst_version].join('\u0000');
}

/** 4 元口径证据索引（链证据聚合的查询面）。 */
export type EvidenceIndex = Map<string, EdgeEvidence>;

/**
 * 一条候选链的边证据聚合口径（纯算法；按域分组后逐链汇总）。
 * edges：链内边数；evidenced：有证据行命中的边数；success_total/fail_total：
 * 命中行的成功/失败计数合计；cost_total：命中行 avg_cost 合计（无证据边按 0）。
 */
export class ChainEvidence {
  readonly edges: number;
  readonly evidenced: number;
  readonly success_total: number;
  readonly fail_total: number;
  readonly cost_total: number;

  constructor(init: {
    edges?: number;
    evidenced?: number;
    success_total?: number;
    fail_total?: number;
    cost_total?: number;
  } = {}) {
    this.edges = init.edges ?? 0;
    this.evidenced = init.evidenced ?? 0;
    this.success_total = init.success_total ?? 0;
    this.fail_total = init.fail_total ?? 0;
    this.cost_total = init.cost_total ?? 0.0;
  }

  /** 支流边证据均值：成功计数均值（无命中行 = 0）。 */
  get mean_success(): number {
    return this.edges ? this.success_total / this.edges : 0.0;
  }

  /** 支流边证据均值：失败计数均值（无命中行 = 0）。 */
  get mean_fail(): number {
    return this.edges ? this.fail_total / this.edges : 0.0;
  }

  /** 支流边证据均值：成本均值（无证据 = 0，裁决的成本对照口径）。 */
  get mean_cost(): number {
    return this.edges ? this.cost_total / this.edges : 0.0;
  }

  /** 链路成本核算（单径成本基准 B 的数据源）。 */
  get cost_estimate(): number {
    return this.cost_total;
  }

  /** 支流边证据均值推导档（derive_edge_tier 同源公式）。 */
  get tier(): string {
    return derive_edge_tier(
      Math.round(this.mean_success),
      Math.round(this.mean_fail),
    );
  }
}

/** 链内一条边（类型 + 契约版本引用；证据入口键）。 */
export class EdgeRef {
  readonly src: string;
  readonly dst: string;
  readonly src_version: string;
  readonly dst_version: string;

  constructor(src: string, dst: string, src_version: string, dst_version: string) {
    this.src = src;
    this.dst = dst;
    this.src_version = src_version;
    this.dst_version = dst_version;
  }

  /** 证据入口键（类型级：variant_hash 恒空归类型级口径）。 */
  evidence_key(domain: string): EdgeKey {
    return {
      src_type: this.src,
      dst_type: this.dst,
      src_contract_version: this.src_version,
      dst_contract_version: this.dst_version,
      context_domain: domain,
      variant_hash: '',
    };
  }

  to_dict(): Record<string, unknown> {
    return {
      src: this.src,
      dst: this.dst,
      src_version: this.src_version,
      dst_version: this.dst_version,
    };
  }
}

/** 候选链 → 边引用列（契约版本取自绑定契约快照；缺省版本入键）。 */
export function chain_edge_refs(
  candidate: AssemblyCandidate,
): readonly EdgeRef[] {
  const bindings = candidate.graph.node_bindings;
  const chain = candidate.chain;
  const refs: EdgeRef[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const src = chain[i]!;
    const dst = chain[i + 1]!;
    const src_contract = bindings[src];
    const dst_contract = bindings[dst];
    refs.push(
      new EdgeRef(
        src,
        dst,
        src_contract !== undefined && src_contract.contract !== null
          ? String(src_contract.contract.version)
          : DEFAULT_CONTRACT_VERSION,
        dst_contract !== undefined && dst_contract.contract !== null
          ? String(dst_contract.contract.version)
          : DEFAULT_CONTRACT_VERSION,
      ),
    );
  }
  return refs;
}

/** 候选链收尾结点产出字段集（同构判定口径）。 */
export function chain_terminal_fields(
  candidate: AssemblyCandidate,
): readonly string[] {
  const chain = candidate.chain;
  if (chain.length === 0) return [];
  const binding = candidate.graph.node_bindings[chain[chain.length - 1]!];
  const contract = binding !== undefined ? binding.contract : null;
  if (contract === null || contract.output_schema === null) return [];
  return [...produced_field_names(contract.output_schema)].sort();
}

/** 候选链证据聚合（索引内一次枚举；无命中 = 零证据口径）。 */
export function chain_evidence(
  candidate: AssemblyCandidate,
  evidence_index: EvidenceIndex,
): ChainEvidence {
  let edges = 0;
  let evidenced = 0;
  let success = 0;
  let fail = 0;
  let cost = 0.0;
  for (const ref of chain_edge_refs(candidate)) {
    edges += 1;
    const row = evidence_index.get(
      index_key(ref.src, ref.dst, ref.src_version, ref.dst_version),
    );
    if (row === undefined) continue;
    evidenced += 1;
    success += row.success_count;
    fail += row.fail_count;
    cost += row.avg_cost;
  }
  return new ChainEvidence({
    edges,
    evidenced,
    success_total: success,
    fail_total: fail,
    cost_total: cost,
  });
}

/** 域内证据行 → 内存索引（组装/裁决全程在内存中计分）。
 *  口径 = 类型级（variant_hash 空）：变体专属证据不参与类型级聚合。 */
export function evidence_index_of(rows: readonly EdgeEvidence[]): EvidenceIndex {
  const index: EvidenceIndex = new Map<string, EdgeEvidence>();
  for (const row of rows) {
    if (row.key.variant_hash !== '') continue;
    index.set(
      index_key(
        row.key.src_type,
        row.key.dst_type,
        row.key.src_contract_version,
        row.key.dst_contract_version,
      ),
      row,
    );
  }
  return index;
}
