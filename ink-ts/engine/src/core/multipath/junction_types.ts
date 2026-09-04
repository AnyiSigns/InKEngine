/**
 * 汇流裁决数据形态（multipath.py Junction 段数据类移植，1:1）。
 *
 * JunctionBranch = 一条已完成执行的支流（裁决输入：产物 + 证据口径）；
 * JunctionVerdict = 汇流裁决收口（胜者 + 汇流产物 + 裁决理由 + 证据更新
 * 计划）；JunctionSynthContext = 异构合成上下文（结构化输入；提示词模板
 * 归使用方）。全部为纯数据形态（frozen 语义由 readonly 表达），to_dict /
 * from_dict 经 JSON 通道传递（Junction 节点数据形态落状态通道）。
 */

import { isRecord } from '../json.js';
import { DEFAULT_CONTRACT_VERSION, TIER_OBSERVING } from '../edge_evidence/index.js';
import {
  ChainEvidence,
  EdgeRef,
} from './evidence.js';

/** 从数据字典还原证据聚合口径（None = 零证据口径）。 */
function evidence_from_dict(raw: unknown): ChainEvidence | null {
  if (!isRecord(raw)) return null;
  return new ChainEvidence({
    edges: Number(raw['edges'] ?? 0),
    evidenced: Number(raw['evidenced'] ?? 0),
    success_total: Number(raw['success_total'] ?? 0),
    fail_total: Number(raw['fail_total'] ?? 0),
    cost_total: Number(raw['cost_total'] ?? 0.0),
  });
}

/**
 * 一条已完成执行的支流（裁决输入：产物 + 证据口径）。
 * index：支流序号；chain：主链类型名序列；overlay：执行回流增量（产物
 * 镜像）；terminal_fields：收尾结点产出字段集（同构判定口径）；edge_refs：
 * 链内边引用列（证据入口）；evidence：链级证据聚合（None = 零证据口径）；
 * graph_path：支流事件路径；description：支流说明（留痕可读）。
 */
export class JunctionBranch {
  readonly index: number;
  readonly chain: readonly string[];
  readonly overlay: Record<string, unknown>;
  readonly terminal_fields: readonly string[];
  readonly edge_refs: readonly EdgeRef[];
  readonly evidence: ChainEvidence | null;
  readonly graph_path: readonly string[];
  readonly description: string;

  constructor(init: {
    index: number;
    chain: readonly string[];
    overlay: Record<string, unknown>;
    terminal_fields?: readonly string[];
    edge_refs?: readonly EdgeRef[];
    evidence?: ChainEvidence | null;
    graph_path?: readonly string[];
    description?: string;
  }) {
    this.index = init.index;
    this.chain = [...init.chain];
    this.overlay = { ...init.overlay };
    this.terminal_fields = [...(init.terminal_fields ?? [])];
    this.edge_refs = [...(init.edge_refs ?? [])];
    this.evidence = init.evidence ?? null;
    this.graph_path = [...(init.graph_path ?? [])];
    this.description = init.description ?? '';
  }

  /** 支流信任档（无证据口径 = 观察档）。 */
  get tier(): string {
    return this.evidence !== null ? this.evidence.tier : TIER_OBSERVING;
  }

  /** 支流证据成本均值（无证据 = 0，裁决的成本对照口径）。 */
  get mean_cost(): number {
    return this.evidence !== null ? this.evidence.mean_cost : 0.0;
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      index: this.index,
      chain: [...this.chain],
      overlay: { ...this.overlay },
      terminal_fields: [...this.terminal_fields],
      graph_path: [...this.graph_path],
      description: this.description,
    };
    data['evidence'] =
      this.evidence !== null
        ? {
            edges: this.evidence.edges,
            evidenced: this.evidence.evidenced,
            success_total: this.evidence.success_total,
            fail_total: this.evidence.fail_total,
            cost_total: this.evidence.cost_total,
            tier: this.evidence.tier,
          }
        : null;
    return data;
  }

  static from_dict(data: Record<string, unknown>): JunctionBranch {
    const raw_chain = data['chain'];
    const raw_fields = data['terminal_fields'];
    const raw_path = data['graph_path'];
    const raw_refs = data['edge_refs'];
    const refs: EdgeRef[] = [];
    if (Array.isArray(raw_refs)) {
      for (const e of raw_refs) {
        if (!isRecord(e)) continue;
        refs.push(
          new EdgeRef(
            String(e['src'] ?? ''),
            String(e['dst'] ?? ''),
            String(e['src_version'] ?? DEFAULT_CONTRACT_VERSION),
            String(e['dst_version'] ?? DEFAULT_CONTRACT_VERSION),
          ),
        );
      }
    }
    return new JunctionBranch({
      index: Number(data['index'] ?? 0),
      chain: Array.isArray(raw_chain)
        ? (raw_chain as unknown[]).map((v) => String(v))
        : [],
      overlay: isRecord(data['overlay']) ? { ...data['overlay'] } : {},
      terminal_fields: Array.isArray(raw_fields)
        ? (raw_fields as unknown[]).map((v) => String(v))
        : [],
      edge_refs: refs,
      evidence: evidence_from_dict(data['evidence']),
      graph_path: Array.isArray(raw_path)
        ? (raw_path as unknown[]).map((v) => String(v))
        : [],
      description: data['description'] === undefined ? '' : String(data['description']),
    });
  }
}

/**
 * 汇流裁决收口：胜者 + 汇流产物 + 裁决理由 + 证据更新计划。
 * mode：裁决模式（quality_gate/tier/cost/synthetic/none）；homogeneous：
 * 是否同构输出；winner：胜者分支序号（synthetic/none = null）；selection：
 * 汇流产物（胜者整体或合成产物；无裁决 = 空）；reasons：裁决理由（可读
 * 可审计）；losers：负样例分支序号（败者/失败支流）；provenance：来源留痕。
 */
export class JunctionVerdict {
  readonly mode: string;
  readonly homogeneous: boolean;
  readonly winner: number | null;
  readonly selection: Record<string, unknown>;
  readonly reasons: readonly string[];
  readonly losers: readonly number[];
  readonly provenance: readonly Record<string, unknown>[];

  constructor(init: {
    mode: string;
    homogeneous: boolean;
    winner: number | null;
    selection: Record<string, unknown>;
    reasons?: readonly string[];
    losers?: readonly number[];
    provenance?: readonly Record<string, unknown>[];
  }) {
    this.mode = init.mode;
    this.homogeneous = init.homogeneous;
    this.winner = init.winner;
    this.selection = { ...init.selection };
    this.reasons = [...(init.reasons ?? [])];
    this.losers = [...(init.losers ?? [])];
    this.provenance = (init.provenance ?? []).map((p) => ({ ...p }));
  }

  to_dict(): Record<string, unknown> {
    return {
      mode: this.mode,
      homogeneous: this.homogeneous,
      winner: this.winner,
      selection: { ...this.selection },
      reasons: [...this.reasons],
      losers: [...this.losers],
      provenance: this.provenance.map((p) => ({ ...p })),
    };
  }
}

/**
 * 合成上下文（结构化输入；提示词模板归使用方）。
 * domain：上下文域；goal：目标字段；branches：支流摘要（索引/链/产物
 * 字段/证据档）；notes：合成触发指引（异构/全败等状况说明）。
 */
export class JunctionSynthContext {
  readonly domain: string;
  readonly goal: readonly string[];
  readonly branches: readonly JunctionBranch[];
  readonly notes: readonly string[];

  constructor(init: {
    domain: string;
    goal: readonly string[];
    branches: readonly JunctionBranch[];
    notes?: readonly string[];
  }) {
    this.domain = init.domain;
    this.goal = [...init.goal];
    this.branches = [...init.branches];
    this.notes = [...(init.notes ?? [])];
  }

  to_dict(): Record<string, unknown> {
    return {
      domain: this.domain,
      goal: [...this.goal],
      branches: this.branches.map((b) => b.to_dict()),
      notes: [...this.notes],
    };
  }
}
