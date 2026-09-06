import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

import type { ArchitectureBackend, EdgeSnapshotData, PoolSnapshotData } from './backend';

/** 把 pool.snapshot 原始出参收敛为视图形态（结构不匹配 = null 空态）。 */
function mapPool(raw: unknown): PoolSnapshotData | null {
  const snap = raw as
    | {
        available?: boolean;
        counts?: Record<string, unknown>;
        governance_log?: Array<Record<string, unknown>>;
        last_round?: Record<string, unknown> | null;
        degraded?: boolean;
      }
    | null
    | undefined;
  if (!snap) return null;
  const counts = snap.counts ?? {};
  const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const rows: PoolSnapshotData['rows'] = (snap.governance_log ?? [])
    .filter((row) => typeof row === 'object' && row !== null)
    .slice(0, 50)
    .map((row) => ({
      node_id: typeof row['node_id'] === 'string' ? row['node_id'] : '',
      verdict: typeof row['verdict'] === 'string' ? row['verdict'] : '',
      ts: typeof row['ts'] === 'number' ? row['ts'] : null,
      budget_remaining: typeof row['budget_remaining'] === 'number' ? row['budget_remaining'] : null,
      reasons: Array.isArray(row['reasons'])
        ? (row['reasons'] as unknown[]).filter((r): r is string => typeof r === 'string')
        : [],
    }));
  const last = snap.last_round ?? null;
  return {
    available: snap.available === true,
    counts: {
      pool_count: toNum(counts['pool_count']),
      evaluations: toNum(counts['evaluations']),
      dead_node_candidates: toNum(counts['dead_node_candidates']),
      near_duplicate_merges: toNum(counts['near_duplicate_merges']),
      weekly_budget_used: toNum(counts['weekly_budget_used']),
      weekly_budget_remaining:
        counts['weekly_budget_remaining'] === undefined || counts['weekly_budget_remaining'] === null
          ? null
          : toNum(counts['weekly_budget_remaining']),
      verdict_counts:
        typeof counts['verdict_counts'] === 'object' && counts['verdict_counts'] !== null
          ? { ...(counts['verdict_counts'] as Record<string, number>) }
          : {},
    },
    last_round: last
      ? {
          node_id: typeof last['node_id'] === 'string' ? last['node_id'] : null,
          verdict: typeof last['verdict'] === 'string' ? last['verdict'] : null,
          ts: typeof last['ts'] === 'number' ? last['ts'] : null,
          budget_remaining: typeof last['budget_remaining'] === 'number' ? last['budget_remaining'] : null,
        }
      : null,
    rows,
    degraded: snap.degraded === true,
  };
}

/** 把 edge_evidence.list 原始出参收敛为视图形态（无 store = 空态）。 */
function mapEdges(raw: unknown): EdgeSnapshotData | null {
  const snap = raw as
    | {
        available?: boolean;
        edges?: Array<Record<string, unknown>>;
      }
    | null
    | undefined;
  if (!snap) return null;
  const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const edges = (snap.edges ?? [])
    .filter((row) => typeof row === 'object' && row !== null)
    .map((row) => ({
      src_type: typeof row['src_type'] === 'string' ? row['src_type'] : '',
      dst_type: typeof row['dst_type'] === 'string' ? row['dst_type'] : '',
      src_contract_version: typeof row['src_contract_version'] === 'string' ? row['src_contract_version'] : '',
      dst_contract_version: typeof row['dst_contract_version'] === 'string' ? row['dst_contract_version'] : '',
      context_domain: typeof row['context_domain'] === 'string' ? row['context_domain'] : 'default',
      success_count: toNum(row['success_count']),
      fail_count: toNum(row['fail_count']),
      avg_cost: toNum(row['avg_cost']),
      policy: row['policy'] === true,
      origin: typeof row['origin'] === 'string' ? row['origin'] : 'runtime',
      last_used_at: row['last_used_at'] === undefined || row['last_used_at'] === null ? null : toNum(row['last_used_at']),
      created_at: toNum(row['created_at']),
    }));
  return { available: snap.available === true, edges };
}

/** 生产后端：host adapter 只读投影（模板校验/试跑/落链为假演示，不提供）。 */
export function createLiveArchitectureBackend(adapter: BackendAdapter = createBackend()): ArchitectureBackend {
  return {
    async fetchPool(): Promise<PoolSnapshotData | null> {
      if (!adapter.available) return null;
      try {
        return mapPool(await adapter.poolSnapshot());
      } catch {
        return null;
      }
    },
    async evaluateProposal(nodeId: string): Promise<Record<string, unknown> | null> {
      if (!adapter.available || nodeId.trim() === '') return null;
      try {
        return (await adapter.poolEvaluate({ node_id: nodeId.trim() })) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async fetchEdgeEvidence(): Promise<EdgeSnapshotData | null> {
      if (!adapter.available) return null;
      try {
        return mapEdges(await adapter.edgeEvidenceList());
      } catch {
        return null;
      }
    },
  };
}
