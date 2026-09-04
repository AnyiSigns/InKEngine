/**
 * 汇流证据更新计划与落库 + 审计记录（multipath.py 归因/审计段移植，1:1）。
 *
 * 归因规则：成功全边 +1（路径全通才证明每条边有效）；败者/失败支流只记
 * 收尾结点入边（枝尾入边）失败 +1——一次下游失败不得毒化整条链。合成/
 * 无裁决（无胜者）时：已执行失败支流记负样例，未失败支流中性不记（合成
 * ≠ 失败，不产生负样例）。审计记录 append-only，本模块只产出不落库。
 */

import { EdgeEvidenceStore } from '../edge_evidence/index.js';
import type { EdgeKey } from '../edge_evidence/index.js';
import { EVENT_AUDIT_JUNCTION } from '../event_types/eventTypeSpecs.js';
import { UPDATE_FAIL, UPDATE_SUCCESS } from './constants.js';
import { JunctionBranch, JunctionVerdict } from './junction_types.js';

/** 汇流证据更新项（胜者边成功 / 败者入边失败；由调用方落库）。 */
export class JunctionEvidenceUpdate {
  readonly key: EdgeKey;
  readonly kind: string; // UPDATE_SUCCESS / UPDATE_FAIL

  constructor(key: EdgeKey, kind: string) {
    this.key = { ...key };
    this.kind = kind;
  }

  to_dict(): Record<string, unknown> {
    return { key: { ...this.key }, kind: this.kind };
  }
}

/**
 * 证据更新计划（归因规则：成功全边 +1；失败只记入边失败 +1）。
 *
 * 胜者全边成功；败者/失败支流只记收尾结点入边失败 +1。合成/无裁决
 * （无胜者）时：已执行失败支流记负样例，未失败支流中性不记。
 */
export function plan_junction_updates(
  verdict: JunctionVerdict,
  branches: readonly JunctionBranch[],
  opts: { domain: string; failed_indexes?: readonly number[] },
): readonly JunctionEvidenceUpdate[] {
  const domain = opts.domain;
  const failed = new Set(opts.failed_indexes ?? []);
  const updates: JunctionEvidenceUpdate[] = [];
  for (const branch of branches) {
    if (verdict.winner === branch.index) {
      for (const ref of branch.edge_refs) {
        updates.push(new JunctionEvidenceUpdate(ref.evidence_key(domain), UPDATE_SUCCESS));
      }
    } else if (failed.has(branch.index) || verdict.winner !== null) {
      for (const ref of branch.edge_refs.slice(-1)) {
        updates.push(new JunctionEvidenceUpdate(ref.evidence_key(domain), UPDATE_FAIL));
      }
    }
  }
  return updates;
}

/** 证据更新落库（胜利/失败归集；返回落库条数）。 */
export async function apply_junction_updates(
  store: EdgeEvidenceStore,
  updates: readonly JunctionEvidenceUpdate[],
  opts: { now?: number | null } = {},
): Promise<number> {
  const now = opts.now ?? null;
  let applied = 0;
  for (const update of updates) {
    if (update.kind === UPDATE_SUCCESS) {
      await store.record_success(update.key, { now });
    } else {
      await store.record_failure(update.key, { now });
    }
    applied += 1;
  }
  return applied;
}

/** 汇流裁决审计记录（append-only；类型名与事件注册表登记一致）。 */
export function junction_audit_record(
  verdict: JunctionVerdict,
  branches: readonly JunctionBranch[],
  opts: { domain: string; fingerprint?: string; ts: number },
): Record<string, unknown> {
  return {
    type: EVENT_AUDIT_JUNCTION,
    ts: opts.ts,
    domain: opts.domain,
    fingerprint: opts.fingerprint ?? '',
    mode: verdict.mode,
    homogeneous: verdict.homogeneous,
    winner: verdict.winner,
    losers: [...verdict.losers],
    reasons: [...verdict.reasons],
    branches: branches.map((b) => b.to_dict()),
  };
}
