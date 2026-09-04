/**
 * 组装验证候选 → 技能条目（skill_crystal.py build_assembly_skill_entry 移植）：
 * canary 单回合通过，低频长尾进技能池。
 *
 * 与高频结晶（crystallize_from_cache）的差异：
 * - 来源 = 组装候选路径（canary 验证通过），非指纹缓存命中统计——这是
 *   「复现 → 泛化」的第一格：没走过的路经验证也能结晶；
 * - hit/fail 计数 = 0（单次验证无命中统计）；test_report 标注「证据待积累」
 *   ——冷启动阶段 edge_evidence 可能全零，报告不谎报成功率；
 * - 版本 = 1；去重（同名/同指纹）由接线侧（技能候选池审批前）判定。
 *
 * 候选/裁决/边证据均为组装（executor）侧形态——此处以结构化 duck 面表达，
 * 组装器迁移后按该形状注入（零 LLM、零 IO、纯派生）。
 */

import { classify_skill_kind } from './mechanism.js';
import { SkillEntry } from './skill_entry.js';

/** 组装图结点绑定（type_name + 契约版本钉死）。 */
export type GraphNodeBindingLike = {
  type_name: string;
  contract?: { version?: string | number | null } | null;
};

/** 组装候选所需图面（node_bindings 顺序 = 链序；to_dict 含 nodes 定义）。 */
export type SkillGraphLike = {
  node_bindings: Readonly<Record<string, GraphNodeBindingLike>>;
  to_dict(): Record<string, unknown>;
};

/** 组装验证候选（graph = 可重建路径图定义）。 */
export type AssemblyCandidateLike = {
  graph: SkillGraphLike;
};

/** 组装裁决（ok = canary 通过；digest = 路径图指纹）。 */
export type AssemblyVerdictLike = {
  ok: boolean;
  digest?: string | null;
};

/** 边证据行（evidence_snapshot 的域内 s/f 计数形态）。 */
export type EvidenceEdgeLike = {
  src_type: string;
  dst_type: string;
  key?: { src_contract_version?: string | null; dst_contract_version?: string | null } | null;
  context_domain?: string | null;
  success_count?: number | null;
  fail_count?: number | null;
};

/** 组装候选技能名：asm.<链类型名>（确定性、可读、可去重）。 */
export function _assembly_skill_name(chain: readonly string[]): string {
  return `asm.${chain.join('.')}`;
}

/**
 * 组装验证候选 → 技能条目（canary 单回合通过，低频长尾进技能池）。
 * now 缺省 = 0（时间 seam 缺省确定值；宿主注入实时钟）。
 */
export function build_assembly_skill_entry(
  candidate: AssemblyCandidateLike,
  verdict: AssemblyVerdictLike,
  opts: {
    domain: string;
    model_id: string;
    evidence_edges?: readonly EvidenceEdgeLike[];
    now?: number | null;
  },
): SkillEntry {
  const nowTs = opts.now ?? 0;
  const graph = candidate.graph;
  const chain = Object.keys(graph.node_bindings);
  const name = _assembly_skill_name(chain);
  const contractSnapshot = chain.map((bindingName) => {
    const binding = graph.node_bindings[bindingName];
    const rawVersion =
      binding === undefined ? null : binding.contract?.version ?? null;
    return [
      binding?.type_name ?? '',
      String(rawVersion === null || rawVersion === undefined ? '1' : rawVersion),
    ] as const;
  });
  const evidenceSnapshot = (opts.evidence_edges ?? []).map((edge) => {
    const srcVersion = edge.key?.src_contract_version ?? '';
    const dstVersion = edge.key?.dst_contract_version ?? '';
    return {
      src_type: String(edge.src_type),
      dst_type: String(edge.dst_type),
      src_contract_version: String(srcVersion ?? ''),
      dst_contract_version: String(dstVersion ?? ''),
      context_domain: String(edge.context_domain || opts.domain),
      success_count: Number(edge.success_count ?? 0),
      fail_count: Number(edge.fail_count ?? 0),
    };
  });
  const hasEvidence =
    evidenceSnapshot.length > 0 &&
    evidenceSnapshot.some(
      (row) => Number(row.success_count) > 0 || Number(row.fail_count) > 0,
    );
  const graphDict = graph.to_dict();
  const skillKind = classify_skill_kind(graphDict);
  const testReport: Record<string, unknown> = {
    skill_name: name,
    version: 1,
    skill_kind: skillKind,
    domain: opts.domain,
    model_id: opts.model_id,
    success_rate: verdict.ok ? 1.0 : null,
    hit_count: 0,
    fail_count: 0,
    sample_edges: evidenceSnapshot.map((row) => ({
      src_type: row['src_type'],
      dst_type: row['dst_type'],
      success_count: row['success_count'],
      fail_count: row['fail_count'],
    })),
    generated_at: nowTs,
    note:
      (verdict.ok
        ? '组装验证路径结晶（canary 单回合通过）'
        : '组装候选（canary 未通过，不应落库）') +
      (hasEvidence ? '' : '；证据待积累'),
  };
  const digest = String(verdict.digest ?? '');
  return new SkillEntry({
    name,
    version: 1,
    domain: opts.domain,
    fingerprint: digest,
    kind: skillKind,
    path: { ...graphDict },
    contract_snapshot: contractSnapshot,
    evidence_snapshot: evidenceSnapshot,
    model_id: opts.model_id,
    hit_count: 0,
    fail_count: 0,
    test_report: testReport,
    source_path: digest,
    created_at: nowTs,
    updated_at: nowTs,
  });
}
