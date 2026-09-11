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

/** 机制视图后端契约（生产 = host adapter 只读投影）。 */
export interface ArchitectureBackend {
  fetchEdgeEvidence(): Promise<EdgeSnapshotData | null>;
}