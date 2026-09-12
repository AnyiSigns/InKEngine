/**
 * 边证据的 records 通道存储（EdgeEvidenceStorage 的受控持久化实现）。
 *
 * 引擎自承载持久化：宿主注入 Storage（sqlite 由宿主驱动），证据行以
 * 记录集合形态落库——键 = 边主键序元的 join 编码（与 InMemory 同口径），
 * 值 = 证据行 dict。读写全部经 Storage seam 进出，core 零 IO；记录集合
 * 非演化资产集合（直写放行），机制写入不再旁路。
 *
 * 与内存实现语义逐条对齐：put 覆盖整行、origin 翻写、record_success/
 * record_failure 为读改写（records 通道无原子自增，量级可忽略）。
 */

import type { EdgeEvidence } from './_types.js';
import { ORIGIN_POLICY, ORIGIN_RUNTIME } from './_types.js';
import {
  EdgeEvidenceStorage,
  EdgeKeyTuple,
  edge_key_tuple,
} from './storage_seam.js';
import { edge_evidence_from_dict, edge_evidence_to_dict } from './store.js';
import type { Storage } from '../../../dock/ports/storage.js';

/** 边证据持久化集合（records 通道普通命名空间，非受守卫演化资产集合）。 */
export const EDGE_EVIDENCE_COLLECTION = 'edge_evidence';

/** 记录键编码（镜像 edge_key_str：六元序元 join('::')）。 */
function _key_of(tuple: EdgeKeyTuple): string {
  return tuple.join('::');
}

/** list_edges 的确定性排序（镜像 InMemoryEdgeEvidenceStorage）。 */
function _sort_rows(rows: EdgeEvidence[]): EdgeEvidence[] {
  return rows.sort((a, b) => {
    if (a.key.context_domain !== b.key.context_domain) {
      return a.key.context_domain < b.key.context_domain ? -1 : 1;
    }
    if (a.key.src_type !== b.key.src_type) {
      return a.key.src_type < b.key.src_type ? -1 : 1;
    }
    if (a.key.dst_type !== b.key.dst_type) {
      return a.key.dst_type < b.key.dst_type ? -1 : 1;
    }
    if (a.key.src_contract_version !== b.key.src_contract_version) {
      return a.key.src_contract_version < b.key.src_contract_version ? -1 : 1;
    }
    if (a.key.dst_contract_version !== b.key.dst_contract_version) {
      return a.key.dst_contract_version < b.key.dst_contract_version ? -1 : 1;
    }
    return 0;
  });
}

/** records 通道的边证据存储（Storage 注入；集合名可按集隔离覆写）。 */
export class RecordsEdgeEvidenceStorage implements EdgeEvidenceStorage {
  readonly #storage: Storage;
  readonly #collection: string;

  constructor(storage: Storage, opts: { collection?: string } = {}) {
    this.#storage = storage;
    this.#collection = opts.collection ?? EDGE_EVIDENCE_COLLECTION;
  }

  async get(key: EdgeKeyTuple): Promise<EdgeEvidence | null> {
    const record = await this.#storage.get_record(this.#collection, _key_of(key));
    if (record === null || record === undefined) return null;
    return edge_evidence_from_dict(record);
  }

  async put(evidence: EdgeEvidence): Promise<EdgeEvidence> {
    const origin = evidence.policy ? ORIGIN_POLICY : evidence.origin;
    const stored: EdgeEvidence = { ...evidence, origin };
    await this.#storage.put_record(
      this.#collection,
      _key_of(edge_key_tuple(stored.key)),
      edge_evidence_to_dict(stored) as Record<string, unknown>,
    );
    return { ...stored };
  }

  async record_success(
    key: EdgeKeyTuple,
    opts: { cost?: number | null; now?: number | null; delta?: number } = {},
  ): Promise<EdgeEvidence> {
    const delta = opts.delta ?? 1;
    const ts = opts.now ?? null;
    const existing = await this.get(key);
    const prevN = existing === null ? 0 : existing.success_count + existing.fail_count;
    const newN = prevN + delta;
    const newSuccess = (existing?.success_count ?? 0) + delta;
    let avgCost = existing?.avg_cost ?? 0.0;
    if (opts.cost !== null && opts.cost !== undefined && newN > 0) {
      avgCost = (avgCost * prevN + opts.cost * delta) / newN;
    }
    const origin = delta > 0 ? ORIGIN_RUNTIME : existing?.origin ?? ORIGIN_RUNTIME;
    return await this.put({
      key: {
        src_type: key[0],
        dst_type: key[1],
        src_contract_version: key[2],
        dst_contract_version: key[3],
        context_domain: key[4],
        variant_hash: key[5],
      },
      success_count: newSuccess,
      fail_count: existing?.fail_count ?? 0,
      avg_cost: avgCost,
      policy: existing?.policy ?? false,
      origin,
      last_used_at: ts,
      created_at: existing?.created_at ?? (ts ?? 0),
    });
  }

  async record_failure(
    key: EdgeKeyTuple,
    opts: { cost?: number | null; now?: number | null; delta?: number } = {},
  ): Promise<EdgeEvidence> {
    const delta = opts.delta ?? 1;
    const ts = opts.now ?? null;
    const existing = await this.get(key);
    const prevN = existing === null ? 0 : existing.success_count + existing.fail_count;
    const newN = prevN + delta;
    const newFail = (existing?.fail_count ?? 0) + delta;
    let avgCost = existing?.avg_cost ?? 0.0;
    if (opts.cost !== null && opts.cost !== undefined && newN > 0) {
      avgCost = (avgCost * prevN + opts.cost * delta) / newN;
    }
    const origin = delta > 0 ? ORIGIN_RUNTIME : existing?.origin ?? ORIGIN_RUNTIME;
    return await this.put({
      key: {
        src_type: key[0],
        dst_type: key[1],
        src_contract_version: key[2],
        dst_contract_version: key[3],
        context_domain: key[4],
        variant_hash: key[5],
      },
      success_count: existing?.success_count ?? 0,
      fail_count: newFail,
      avg_cost: avgCost,
      policy: existing?.policy ?? false,
      origin,
      last_used_at: ts,
      created_at: existing?.created_at ?? (ts ?? 0),
    });
  }

  async list_edges(domain: string | null = null): Promise<EdgeEvidence[]> {
    const rows: EdgeEvidence[] = [];
    for (const record of await this.#storage.list_records(this.#collection)) {
      const ev = edge_evidence_from_dict(record);
      if (domain === null || ev.key.context_domain === domain) rows.push(ev);
    }
    return _sort_rows(rows);
  }

  async evidence_count(domain: string | null = null): Promise<number> {
    let n = 0;
    for (const record of await this.#storage.list_records(this.#collection)) {
      if (domain === null || record['context_domain'] === domain) n += 1;
    }
    return n;
  }
}
