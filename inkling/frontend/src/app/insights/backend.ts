import { invokeOp } from '../shared/invokeOp';

export interface WhyCandidate {
  domain?: string;
  candidate_id?: string;
  chain?: Array<string | number>;
  chosen_at?: number;
}

export interface WhyReason {
  type?: string;
  ts?: number;
  domain?: string;
  reason?: string | null;
  action?: string | null;
  review_tier?: string | null;
  candidate_id?: string | null;
  src_type?: string | null;
  dst_type?: string | null;
}

export interface WhyEdge {
  src_type?: string;
  dst_type?: string;
  success_count?: number;
  fail_count?: number;
  policy?: boolean;
  avg_cost?: number;
}

export interface WhyAuditData {
  domain?: string;
  candidates?: WhyCandidate[];
  reason_chain?: WhyReason[];
  edge_evidence?: WhyEdge[];
}

export interface SovereigntySnapshot {
  local_storage?: { backend?: string | null; location?: string };
  skill_store_path?: string | null;
  model_tiers?: string[];
  tier_call_stats_persisted?: boolean;
  audit_total?: number;
  audit_counts?: Record<string, number>;
  recent_audit?: Array<{ type?: string | null; ts?: number }>;
}

export interface Suggestion {
  rule_id?: string;
  message?: string;
  severity?: string;
}

export interface SuggestionScan {
  suggestions?: Suggestion[];
}

export interface InsightOps {
  whyAudit(): Promise<WhyAuditData>;
  sovereigntySnapshot(): Promise<SovereigntySnapshot>;
  suggestionScan(): Promise<SuggestionScan>;
}

export function createInsightOps(): InsightOps {
  return {
    whyAudit: async () => {
      const result = await invokeOp<WhyAuditData>('why.audit', {});
      return result ?? {};
    },
    sovereigntySnapshot: async () => {
      const result = await invokeOp<SovereigntySnapshot>('sovereignty.snapshot', {});
      return result ?? {};
    },
    suggestionScan: async () => {
      const result = await invokeOp<SuggestionScan>('suggestion.scan', {});
      return result ?? { suggestions: [] };
    },
  };
}
