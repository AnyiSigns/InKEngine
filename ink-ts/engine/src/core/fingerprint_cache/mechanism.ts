/**
 * 指纹缓存纯机制判定（无存储依赖，可直接单测）：
 * - 契约版本快照提取（类型 → 契约版本，图定义数据随行落库）；
 * - 证据漂移判定（相对差 ≥ 阈值 或 信任档变化，防小样本噪声）；
 * - 顶替审计记录构造（类型名与事件注册表登记一致）。
 * 信任档推导复用 edge_evidence.derive_edge_tier（档位 = 评分 τ 乘数的
 * 直接决定者，档变 = 评分依据变；计数差不达标也判漂移）。
 */

import {
  DEFAULT_CONTRACT_VERSION,
  derive_edge_tier,
} from '../edge_evidence/index.js';
import { EVENT_AUDIT_FINGERPRINT_REPLACE } from '../event_types/eventTypeSpecs.js';
import { DRIFT_MIN_N, DRIFT_RATIO } from './_types.js';

/** 契约版本快照：从路径图定义数据的节点绑定提取（类型 → 契约版本）。
 *  绑定内契约随图定义数据落库（契约即数据）；缺契约声明的绑定按缺省
 *  版本入快照；非 dict 形态节点绑定跳过；排序保确定性。 */
export function contract_snapshot_from_path(
  path: Record<string, unknown>,
): readonly (readonly [string, string])[] {
  const nodes = path['nodes'];
  if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) return [];
  const snapshot: Array<readonly [string, string]> = [];
  for (const spec of Object.values(nodes as Record<string, unknown>)) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const node = spec as Record<string, unknown>;
    if (!node['type']) continue;
    const contract = node['contract'];
    const version =
      contract !== null &&
      typeof contract === 'object' &&
      !Array.isArray(contract) &&
      (contract as Record<string, unknown>)['version'] !== null &&
      (contract as Record<string, unknown>)['version'] !== undefined
        ? String((contract as Record<string, unknown>)['version'])
        : DEFAULT_CONTRACT_VERSION;
    snapshot.push([String(node['type']), version] as const);
  }
  return [...snapshot].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
}

/** 证据行 → 边键（契约版本入键：升版后旧行自然不命中）。 */
function edge_key_of(row: Record<string, unknown>): readonly [string, string, string, string] {
  return [
    String(row['src_type'] ?? ''),
    String(row['dst_type'] ?? ''),
    String(row['src_contract_version'] ?? DEFAULT_CONTRACT_VERSION),
    String(row['dst_contract_version'] ?? DEFAULT_CONTRACT_VERSION),
  ];
}

/** 证据漂移判定：快照内任一边 s/f 计数相对差 ≥ 阈值或信任档变化。
 *  防小样本噪声：该边样本 N（快照与当前取大）< min_n 不判漂移；信任档
 *  按边证据推导式比较，档位变化即漂移——档变 = 评分依据变。快照未覆盖
 *  的当前新边不参与判定（新证据不推翻旧条目，探索走抽样重装通道）。 */
export function evidence_drifted(
  snapshot: readonly Record<string, unknown>[],
  current: readonly Record<string, unknown>[],
  opts: { drift_ratio?: number; min_n?: number } = {},
): boolean {
  const driftRatio = opts.drift_ratio ?? DRIFT_RATIO;
  const minN = opts.min_n ?? DRIFT_MIN_N;
  const currentByKey = new Map<string, Record<string, unknown>>();
  for (const row of current) {
    currentByKey.set(edge_key_of(row).join('\u0000'), row);
  }
  for (const row of snapshot) {
    const cur = currentByKey.get(edge_key_of(row).join('\u0000')) ?? null;
    const snapS = Math.trunc(Number(row['success_count'] ?? 0));
    const snapF = Math.trunc(Number(row['fail_count'] ?? 0));
    const curS = cur === null ? 0 : Math.trunc(Number(cur['success_count'] ?? 0));
    const curF = cur === null ? 0 : Math.trunc(Number(cur['fail_count'] ?? 0));
    const n = Math.max(snapS + snapF, curS + curF);
    if (n < minN) continue;
    const denom = Math.max(snapS + snapF, 1);
    if (Math.abs(curS - snapS) / denom >= driftRatio) return true;
    if (Math.abs(curF - snapF) / denom >= driftRatio) return true;
    if (derive_edge_tier(snapS, snapF) !== derive_edge_tier(curS, curF)) return true;
  }
  return false;
}

/** 指纹顶替审计记录结构（append-only；与事件注册表登记同型）。 */
export type FingerprintReplaceAuditRecord = {
  type: string;
  ts: number;
  domain: string;
  fingerprint: string;
  old_fingerprint: string;
  reason: string;
  old_score: number;
  new_score: number;
};

/** 指纹顶替审计记录（append-only；类型名与事件注册表登记一致）。 */
export function fingerprint_replace_audit_record(opts: {
  domain: string;
  fingerprint: string;
  old_fingerprint: string;
  reason: string;
  old_score: number;
  new_score: number;
  ts: number;
}): FingerprintReplaceAuditRecord {
  return {
    type: EVENT_AUDIT_FINGERPRINT_REPLACE,
    ts: opts.ts,
    domain: opts.domain,
    fingerprint: opts.fingerprint,
    old_fingerprint: opts.old_fingerprint,
    reason: opts.reason,
    old_score: opts.old_score,
    new_score: opts.new_score,
  };
}