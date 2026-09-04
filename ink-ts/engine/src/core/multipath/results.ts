/**
 * 多径运行收口结果形态（multipath.py BudgetView / 结果数据类段移植，1:1）。
 *
 * BudgetView = 预算只读查询上下文（多径预检的轻量 ctx；策略可读字段最小
 * 集）；MultiPathBranchResult = 一条支流执行结果（终态 + 归因口径 + 子链
 * 锚点）；MultiPathResult = 一次多径执行的收口结果（触发/执行/裁决/证据
 * 回写全量留痕）。全部为纯数据形态，to_dict 可经 JSON 通道传递。
 */

import { ChainEvidence, EdgeRef } from './evidence.js';
import { JunctionVerdict } from './junction_types.js';
import type { JunctionEvidenceUpdate } from './updates.js';

/** 预算只读查询上下文（多径预检的轻量 ctx；策略可读字段最小集）。 */
export class BudgetView {
  readonly node: string | null;
  readonly graph_path: readonly string[];
  readonly step_count: number;
  readonly thread_id: string | null;
  readonly round_id: string | null;
  readonly state: Record<string, unknown>;

  constructor(init: {
    node?: string | null;
    graph_path?: readonly string[];
    step_count?: number;
    thread_id?: string | null;
    round_id?: string | null;
    state?: Record<string, unknown>;
  } = {}) {
    this.node = init.node ?? null;
    this.graph_path = [...(init.graph_path ?? ['multipath'])];
    this.step_count = init.step_count ?? 0;
    this.thread_id = init.thread_id ?? null;
    this.round_id = init.round_id ?? null;
    this.state = { ...(init.state ?? {}) };
  }
}

/** 证据口径 to_dict（与裁决侧同一形状）。 */
function evidence_to_dict(evidence: ChainEvidence): Record<string, unknown> {
  return {
    edges: evidence.edges,
    evidenced: evidence.evidenced,
    success_total: evidence.success_total,
    fail_total: evidence.fail_total,
    cost_total: evidence.cost_total,
    tier: evidence.tier,
  };
}

/**
 * 一条支流执行结果（终态 + 归因口径 + 子链锚点）。
 * index：支流序号；chain：主链类型名序列；digest：候选图指纹（图定义
 * 身份）；overlay：执行回流增量（产物镜像）；final_state：支流终态；
 * terminal：终止原因（reply/stop/error/...）；error：执行失败原因（null =
 * 正常收尾）；interrupt：中断负载（None = 无中断）；evidence：链级证据
 * 聚合（裁决输入口径）；thread_id：独立子链线程 id（回溯/换选锚点）；
 * graph_path：支流事件路径。
 */
export class MultiPathBranchResult {
  readonly index: number;
  readonly chain: readonly string[];
  readonly digest: string;
  readonly overlay: Record<string, unknown>;
  readonly final_state: Record<string, unknown>;
  readonly terminal: string;
  readonly error: string | null;
  readonly interrupt: Record<string, unknown> | null;
  readonly evidence: ChainEvidence | null;
  readonly thread_id: string;
  readonly graph_path: readonly string[];
  readonly terminal_fields: readonly string[];
  readonly edge_refs: readonly EdgeRef[];

  constructor(init: {
    index: number;
    chain: readonly string[];
    digest: string;
    overlay: Record<string, unknown>;
    final_state: Record<string, unknown>;
    terminal: string;
    error: string | null;
    interrupt: Record<string, unknown> | null;
    evidence: ChainEvidence | null;
    thread_id: string;
    graph_path: readonly string[];
    terminal_fields?: readonly string[];
    edge_refs?: readonly EdgeRef[];
  }) {
    this.index = init.index;
    this.chain = [...init.chain];
    this.digest = init.digest;
    this.overlay = { ...init.overlay };
    this.final_state = { ...init.final_state };
    this.terminal = init.terminal;
    this.error = init.error;
    this.interrupt =
      init.interrupt === null ? null : { ...init.interrupt };
    this.evidence = init.evidence;
    this.thread_id = init.thread_id;
    this.graph_path = [...init.graph_path];
    this.terminal_fields = [...(init.terminal_fields ?? [])];
    this.edge_refs = [...(init.edge_refs ?? [])];
  }

  to_dict(): Record<string, unknown> {
    return {
      index: this.index,
      chain: [...this.chain],
      digest: this.digest,
      overlay: { ...this.overlay },
      final_state: { ...this.final_state },
      terminal: this.terminal,
      error: this.error,
      interrupt: this.interrupt === null ? null : { ...this.interrupt },
      evidence: this.evidence !== null ? evidence_to_dict(this.evidence) : null,
      thread_id: this.thread_id,
      graph_path: [...this.graph_path],
      terminal_fields: [...this.terminal_fields],
      edge_refs: this.edge_refs.map((r) => r.to_dict()),
    };
  }
}

/**
 * 一次多径执行的收口结果（触发/执行/裁决/证据回写全量留痕）。
 * triggered：是否实际触发多径（False = 零生效/预检拒绝/候选不足/降级
 * 单径）；k：实际执行径数（1 = 单径降级；0 = 未执行）；candidates：候选
 * 条数；base_cost/budget_required/budget_passed/budget_note：预算口径；
 * degraded_reason：降级原因（null = 未降级）；branches：支流执行结果；
 * verdict：汇流裁决（k≥2 且至少一条成功支流时产出；null = 未裁决）；
 * thread_ids：支流序号 → 子链线程 id；updates：证据更新计划；audit：审计
 * 记录（append-only；落库经 sink/回调）。
 */
export class MultiPathResult {
  readonly triggered: boolean;
  readonly k: number;
  readonly candidates: number;
  readonly base_cost: number;
  readonly budget_required: number;
  readonly budget_passed: boolean;
  readonly budget_note: string;
  readonly degraded_reason: string | null;
  readonly branches: readonly MultiPathBranchResult[];
  readonly verdict: JunctionVerdict | null;
  readonly thread_ids: Record<number, string>;
  readonly updates: readonly JunctionEvidenceUpdate[];
  readonly audit: readonly Record<string, unknown>[];

  constructor(init: {
    triggered: boolean;
    k: number;
    candidates: number;
    base_cost?: number;
    budget_required?: number;
    budget_passed?: boolean;
    budget_note?: string;
    degraded_reason?: string | null;
    branches?: readonly MultiPathBranchResult[];
    verdict?: JunctionVerdict | null;
    thread_ids?: Record<number, string>;
    updates?: readonly JunctionEvidenceUpdate[];
    audit?: readonly Record<string, unknown>[];
  }) {
    this.triggered = init.triggered;
    this.k = init.k;
    this.candidates = init.candidates;
    this.base_cost = init.base_cost ?? 0.0;
    this.budget_required = init.budget_required ?? 0.0;
    this.budget_passed = init.budget_passed ?? true;
    this.budget_note = init.budget_note ?? '';
    this.degraded_reason = init.degraded_reason ?? null;
    this.branches = [...(init.branches ?? [])];
    this.verdict = init.verdict ?? null;
    this.thread_ids = { ...(init.thread_ids ?? {}) };
    this.updates = [...(init.updates ?? [])];
    this.audit = (init.audit ?? []).map((r) => ({ ...r }));
  }

  /** 胜者分支序号（未裁决 = null）。 */
  get winner(): number | null {
    return this.verdict !== null ? this.verdict.winner : null;
  }

  to_dict(): Record<string, unknown> {
    return {
      triggered: this.triggered,
      k: this.k,
      candidates: this.candidates,
      base_cost: this.base_cost,
      budget_required: this.budget_required,
      budget_passed: this.budget_passed,
      budget_note: this.budget_note,
      degraded_reason: this.degraded_reason,
      branches: this.branches.map((b) => b.to_dict()),
      verdict: this.verdict !== null ? this.verdict.to_dict() : null,
      thread_ids: { ...this.thread_ids },
      updates: this.updates.map((u) => u.to_dict()),
      audit: this.audit.map((r) => ({ ...r })),
    };
  }
}
