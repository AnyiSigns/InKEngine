import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

import type {
  ArchitectureBackend,
  EdgeSnapshotData,
} from './backend';

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

/** 生产后端：host adapter 只读投影（pool/instance 等组装链面已随组装链路退役）。 */
export function createLiveArchitectureBackend(adapter: BackendAdapter = createBackend()): ArchitectureBackend {
  return {
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