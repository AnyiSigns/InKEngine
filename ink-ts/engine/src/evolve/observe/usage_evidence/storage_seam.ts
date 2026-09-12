/**
 * 边证据存储 seam：核心域以接口表达（零 sqlite / 零 IO），宿主侧注入
 * SQLite（aiosqlite / better-sqlite3 / 任何实现）。所有 IO 经此 seam
 * 进出；core 仅依赖类型契约。
 *
 * 镜像 Python ink_engine.core.edge_evidence.EdgeEvidenceStore 的方法语义
 * （record_success / record_failure / get / put / list_edges /
 * evidence_count / close）；sqlite 特有的迁移/upsert 由宿主实现负责。
 */

import type { EdgeEvidence } from './_types.js';

/** 单条 evidence 行的 JSON 视图（与 EdgeEvidence.to_dict 同形）。 */
export type EdgeEvidenceRecord = {
  src_type: string;
  dst_type: string;
  src_contract_version: string;
  dst_contract_version: string;
  context_domain: string;
  variant_hash?: string;
  success_count: number;
  fail_count: number;
  avg_cost: number;
  policy?: boolean;
  origin?: string;
  last_used_at?: number | null;
  created_at: number;
};

/** 边主键序元（与 EdgeKey.key() 同形：src/dst/scv/dcv/domain/variant）。 */
export type EdgeKeyTuple = readonly [string, string, string, string, string, string];

/** 边证据持久化 seam：core 零 IO、宿主注入实现。 */
export interface EdgeEvidenceStorage {
  /** 按主键取证据；不存在 = null。 */
  get(key: EdgeKeyTuple): Promise<EdgeEvidence | null>;
  /** 整行写入（已存在覆盖更新；origin 沿用行内声明，policy=true 强制 origin=policy）。 */
  put(evidence: EdgeEvidence): Promise<EdgeEvidence>;
  /**
   * 成功归集（success += delta；cost 滑动均值按 delta 加权，cost=null 不改写）。
   * 首次真实成功把行 origin 翻为 runtime（解除种子降权）。
   */
  record_success(
    key: EdgeKeyTuple,
    opts: { cost?: number | null; now?: number | null; delta?: number },
  ): Promise<EdgeEvidence>;
  /** 失败归集（fail += delta；语义同 record_success）。 */
  record_failure(
    key: EdgeKeyTuple,
    opts: { cost?: number | null; now?: number | null; delta?: number },
  ): Promise<EdgeEvidence>;
  /** 按域枚举（domain=undefined = 全域；只做逐域分组，不跨域聚合）。 */
  list_edges(domain?: string | null): Promise<EdgeEvidence[]>;
  /** 有证据边数（domain=undefined = 全域）。 */
  evidence_count(domain?: string | null): Promise<number>;
  /** 关闭连接（可选；无连接实现可空实现）。 */
  close?(): Promise<void>;
}

/** 边主键 → 序元（与 Python EdgeKey.key() 形状一致）。 */
export function edge_key_tuple(key: import('./_types.js').EdgeKey): EdgeKeyTuple {
  return [
    key.src_type,
    key.dst_type,
    key.src_contract_version,
    key.dst_contract_version,
    key.context_domain,
    key.variant_hash,
  ];
}