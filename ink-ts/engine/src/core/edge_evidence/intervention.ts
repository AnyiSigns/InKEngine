/**
 * 干预能力：信任档降级 + 反向复原（落受控通道）。
 *
 * 信任档由证据计数纯算法推导（derive_edge_tier），本模块把边证据改写为
 * 「恰好落在目标档」的计数（保留 avg_cost / policy / 时间戳），使推导档
 * 降至目标档——人工干预覆盖自动晋级。降级前快照落 edge_tier_overrides
 * 受控通道（EvolutionWriter），set_audit 走 emit_audit；反向复原从快照
 * 回写原证据计数。
 *
 * 目标档非法 / 边不存在 = fail-closed 拒绝（未知 id 不静默）；目标档不
 * 低于当前档（已更低）= 仅留痕不改写。
 */

import { emit_audit, type AuditStorage } from '../audit_log/audit_log.js';
import { EVENT_AUDIT_POLICY_REVIEW } from '../event_types/eventTypeSpecs.js';
import {
  DefaultEvolutionWriter,
  edge_tier_writer,
  type EvolutionStorage,
} from '../evolution_writer/evolution_writer.js';

import { EDGE_TIER_OVERRIDE_COLLECTION, TIER_OBSERVING, TIER_REGULAR } from './_types.js';
import type { EdgeKey } from './_types.js';
import { edge_evidence_to_dict } from './store.js';
import { derive_edge_tier } from './tier_model.js';
import type { EdgeEvidenceStore } from './store.js';

const _TIER_TARGET_COUNTS: { readonly [tier: string]: readonly [number, number] } = {
  [TIER_OBSERVING]: [0, 0],
  [TIER_REGULAR]: [8, 2],
  promoted: [35, 3],
};

function _tier_rank(tier: string): number {
  if (tier === TIER_REGULAR) return 1;
  if (tier === 'promoted') return 2;
  return 0;
}

export interface DowngradeResult {
  src_type: string;
  dst_type: string;
  domain: string;
  from_tier: string;
  to_tier: string;
  changed: boolean;
}

export interface RestoreResult {
  src_type: string;
  dst_type: string;
  domain: string;
  to_tier: string;
  restored: true;
}

export async function downgrade_edge_tier(
  store: EdgeEvidenceStore,
  key: EdgeKey,
  opts: {
    target_tier: string;
    storage?: EvolutionStorage | null;
    reason?: string;
    now?: number | null;
  },
): Promise<DowngradeResult> {
  const targetTier = opts.target_tier;
  if (_TIER_TARGET_COUNTS[targetTier] === undefined) {
    throw new Error(`未知信任档: ${targetTier}（仅 observing/regular/promoted）`);
  }
  const current = await store.get(key);
  if (current === null) {
    throw new Error(`边证据不存在（未知 id）: ${key.src_type}→${key.dst_type}`);
  }
  const ts = opts.now === null || opts.now === undefined ? Date.now() / 1000 : opts.now;
  const reason = opts.reason ?? '';
  const currentTier = derive_edge_tier(current.success_count, current.fail_count);
  const target = _TIER_TARGET_COUNTS[targetTier]!;
  let newSuccess = target[0];
  let newFail = target[1];
  if (_tier_rank(targetTier) >= _tier_rank(currentTier)) {
    newSuccess = current.success_count;
    newFail = current.fail_count;
  }
  if (opts.storage !== null && opts.storage !== undefined) {
    const writer = new DefaultEvolutionWriter(opts.storage);
    const keyStr = [
      key.src_type,
      key.dst_type,
      key.src_contract_version,
      key.dst_contract_version,
      key.context_domain,
      key.variant_hash,
    ].join('::');
    await edge_tier_writer(
      writer,
      EDGE_TIER_OVERRIDE_COLLECTION,
      keyStr,
      edge_evidence_to_dict(current),
      { note: reason || '人工信任档降级' },
    );
    await emit_audit(opts.storage as unknown as AuditStorage, {
      type: EVENT_AUDIT_POLICY_REVIEW,
      ts,
      domain: key.context_domain,
      src_type: key.src_type,
      dst_type: key.dst_type,
      reason: reason || '人工信任档降级',
      action: 'tier_downgraded',
      from_tier: currentTier,
      to_tier: targetTier,
      review_tier: 'l2',
    });
  }
  await store.put({
    key,
    success_count: newSuccess,
    fail_count: newFail,
    avg_cost: current.avg_cost,
    policy: current.policy,
    origin: current.origin,
    last_used_at: current.last_used_at,
    created_at: current.created_at,
  });
  const after = await store.get(key);
  const updatedTier =
    after === null ? currentTier : derive_edge_tier(after.success_count, after.fail_count);
  return {
    src_type: key.src_type,
    dst_type: key.dst_type,
    domain: key.context_domain,
    from_tier: currentTier,
    to_tier: updatedTier,
    changed: newSuccess !== current.success_count || newFail !== current.fail_count,
  };
}

export async function restore_edge_tier(
  store: EdgeEvidenceStore,
  key: EdgeKey,
  opts: { storage?: EvolutionStorage | null } = {},
): Promise<RestoreResult | null> {
  if (opts.storage === null || opts.storage === undefined) return null;
  const keyStr = [
    key.src_type,
    key.dst_type,
    key.src_contract_version,
    key.dst_contract_version,
    key.context_domain,
    key.variant_hash,
  ].join('::');
  const snapshot = await opts.storage.get_record(EDGE_TIER_OVERRIDE_COLLECTION, keyStr);
  if (snapshot === null || snapshot === undefined) return null;
  const { edge_evidence_from_dict } = await import('./store.js');
  const restored = edge_evidence_from_dict(snapshot);
  await store.put({ ...restored, key });
  const after = await store.get(key);
  const restoredTier =
    after === null ? '' : derive_edge_tier(after.success_count, after.fail_count);
  return {
    src_type: key.src_type,
    dst_type: key.dst_type,
    domain: key.context_domain,
    to_tier: restoredTier,
    restored: true,
  };
}