/**
 * 边证据测试共享 helper（对标 ink_engine/tests/test_edge_evidence.py
 * 通用夹具；NOW 常量与 evidence 构造器）。
 */

import type { EdgeEvidence, EdgeKey } from '../../../src/core/edge_evidence/_types.js';

export const NOW = 1_800_000_000;

export function makeEvidence(
  s: number,
  f: number,
  opts: {
    cost?: number;
    domain?: string;
    last_used?: number | null;
    policy?: boolean;
    origin?: string;
  } = {},
): EdgeEvidence {
  const key: EdgeKey = {
    src_type: 'a',
    dst_type: 'b',
    src_contract_version: '1',
    dst_contract_version: '1',
    context_domain: opts.domain ?? 'code',
    variant_hash: '',
  };
  return {
    key,
    success_count: s,
    fail_count: f,
    avg_cost: opts.cost ?? 0.0,
    policy: opts.policy ?? false,
    origin: opts.origin ?? 'runtime',
    last_used_at: opts.last_used === undefined ? NOW : opts.last_used ?? null,
    created_at: NOW,
  };
}

export function makeCandidate(s: number, f: number, name = 'b'): EdgeEvidence {
  return {
    ...makeEvidence(s, f),
    key: { ...makeEvidence(s, f).key, dst_type: name },
  };
}