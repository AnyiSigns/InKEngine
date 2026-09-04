/**
 * 种子路径导入（出厂资产通道只供数据：边证据初始化）。
 *
 * 每条种子 = `{src_type, dst_type, success_count, fail_count, ...}`。
 * 已存在同键行（运行期证据在先）不覆盖——运行统计是事实，种子只补空白。
 */

import { ORIGIN_SEED } from './_types.js';
import type { EdgeEvidence, EdgeKey } from './_types.js';
import { edge_key_from_dict } from './store.js';
import type { EdgeEvidenceStore } from './store.js';

export interface SeedEdgeRaw {
  src_type: string;
  dst_type: string;
  src_contract_version?: string;
  dst_contract_version?: string;
  context_domain?: string;
  variant_hash?: string;
  success_count?: number;
  fail_count?: number;
  avg_cost?: number;
  policy?: boolean;
  last_used_at?: number | null;
  created_at?: number;
}

/** 种子路径导入；已存在同键行不覆盖。返回写入条数。 */
export async function import_seed_paths(
  store: EdgeEvidenceStore,
  seed_edges: readonly SeedEdgeRaw[],
): Promise<number> {
  let written = 0;
  for (const raw of seed_edges) {
    const key = edge_key_from_dict(raw as unknown as Record<string, unknown>);
    const existing = await store.get(key);
    if (existing !== null) continue;
    const ev: EdgeEvidence = {
      key,
      success_count: Math.max(0, Number(raw.success_count ?? 0)),
      fail_count: Math.max(0, Number(raw.fail_count ?? 0)),
      avg_cost: Number(raw.avg_cost ?? 0.0),
      policy: Boolean(raw.policy ?? false),
      origin: ORIGIN_SEED,
      last_used_at:
        raw.last_used_at === undefined || raw.last_used_at === null
          ? null
          : Number(raw.last_used_at),
      created_at: Number(raw.created_at ?? 0.0),
    };
    await store.put(ev);
    written += 1;
  }
  return written;
}