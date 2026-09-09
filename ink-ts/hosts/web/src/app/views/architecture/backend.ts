import type { DagGraph, DagNode, DagNodeKind, DagNodeStatus } from '@app/dag';

/** 结点池登记快照（pool.snapshot 投影：counts/最近判定/governance_log 窗口）。 */
export interface PoolRowView {
  node_id: string;
  verdict: string;
  ts: number | null;
  budget_remaining: number | null;
  reasons: string[];
}

/** 结点类型注册行（pool.snapshot.registry.types 投影；runtime.node_registrations 行）。 */
export interface PoolRegistryTypeRow {
  type_name: string;
  status: string;
  provenance: string;
  executor: string;
}

/** 结点类型注册目录段（pool.snapshot.registry；无数据源 = available:false 空态）。 */
export interface PoolRegistryView {
  available: boolean;
  total_count: number;
  active_count: number;
  types: PoolRegistryTypeRow[];
}

export interface PoolSnapshotData {
  available: boolean;
  counts: {
    pool_count: number;
    evaluations: number;
    dead_node_candidates: number;
    near_duplicate_merges: number;
    weekly_budget_used: number;
    weekly_budget_remaining: number | null;
    verdict_counts: Record<string, number>;
  };
  last_round: { node_id: string | null; verdict: string | null; ts: number | null; budget_remaining: number | null } | null;
  rows: PoolRowView[];
  registry: PoolRegistryView;
  degraded: boolean;
}

/** 边证据条目（edge_evidence.list 投影，引擎字段原样）。 */
export interface EdgeEvidenceRow {
  src_type: string;
  dst_type: string;
  src_contract_version: string;
  dst_contract_version: string;
  context_domain: string;
  success_count: number;
  fail_count: number;
  avg_cost: number;
  policy: boolean;
  origin: string;
  last_used_at: number | null;
  created_at: number;
}

export interface EdgeSnapshotData {
  available: boolean;
  edges: EdgeEvidenceRow[];
}

/** 实例图（只读，最近回合实际跑的图）。 */
export interface InstanceGraph {
  roundId: string;
  graph: DagGraph;
  /** node_start/end 推进的执行态。 */
  nodeStatus: Record<string, DagNodeStatus>;
  /** 最近一回合是否为自动续跑轮（round_id 以 auto: 开头）。 */
  isAutoRound: boolean;
  /** 自动续跑触发原因（evolved/continue；非 auto 轮 = null）。 */
  autoReason: string | null;
}

/** 引擎节点类型 → 前端 DAG 结点 kind 映射（未知类型按终结结点回落）。 */
export function dagNodeKind(type: string | undefined): DagNodeKind {
  if (type === 'orchestrator' || type === 'tool' || type === 'terminal') return type;
  if (type === 'llm_decider' || type === 'assembly_orchestrator') return 'orchestrator';
  if (type === 'tool_pipeline') return 'tool';
  return 'terminal';
}

/**
 * 引擎 graph.instance 响应 → 前端 InstanceGraph 契约映射。
 * 结构不匹配/空态返回 null（渲染层空态降级，不泄漏原始结构）。
 */
export function mapInstanceSnapshot(raw: unknown): InstanceGraph | null {
  const snap = raw as
    | {
        round_id?: string;
        graph?: {
          nodes?: Array<{ id?: unknown; type?: unknown; label?: unknown }>;
          edges?: Array<{ from: string; to: string }>;
        };
        node_status?: Record<string, unknown>;
        auto_round?: boolean;
        continuation_reason?: string | null;
      }
    | null
    | undefined;
  if (!snap || !snap.round_id) return null;
  const nodes: DagNode[] = (snap.graph?.nodes ?? []).map((n) => ({
    id: String(n.id ?? ''),
    label: n.label !== undefined && n.label !== null ? String(n.label) : String(n.id ?? ''),
    kind: dagNodeKind(typeof n.type === 'string' ? n.type : undefined),
  }));
  const graph: DagGraph = {
    nodes,
    edges: (snap.graph?.edges ?? []).map((e) => ({ from: e.from, to: e.to })),
  };
  const nodeStatus: Record<string, DagNodeStatus> = {};
  for (const [name, status] of Object.entries(snap.node_status ?? {})) {
    if (status === 'running' || status === 'success' || status === 'failed' || status === 'idle') {
      nodeStatus[name] = status;
    }
  }
  const isAuto = snap.auto_round === true || String(snap.round_id).startsWith('auto:');
  const reason = snap.continuation_reason;
  return {
    roundId: snap.round_id,
    graph,
    nodeStatus,
    isAutoRound: isAuto,
    autoReason: reason === 'evolved' || reason === 'continue' ? reason : null,
  };
}

/** 机制视图后端契约（生产 = host adapter 只读投影）。 */
export interface ArchitectureBackend {
  fetchPool(): Promise<PoolSnapshotData | null>;
  /** 对给定 node_id 跑一次引擎四规则判定（只登记，不越权写）。 */
  evaluateProposal(nodeId: string): Promise<Record<string, unknown> | null>;
  fetchEdgeEvidence(): Promise<EdgeSnapshotData | null>;
}
