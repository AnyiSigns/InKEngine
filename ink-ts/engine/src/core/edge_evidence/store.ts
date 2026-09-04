/**
 * EdgeEvidenceStore：边证据核心域存储 + 注入 seam 适配层。
 *
 * 构造接受任何实现 EdgeEvidenceStorage 的对象（sqlite/in-memory test
 * fake 均可），默认 = InMemoryEdgeEvidenceStorage（满足无宿主注入场景零依赖
 * 运行；生产由宿主注入 sqlite 实现）。Core 域保持零 IO：所有副作用经
 * seam 进出。
 */

import { StorageError } from '../errors.js';
import {
  DEFAULT_CONTRACT_VERSION,
  ORIGIN_POLICY,
  ORIGIN_RUNTIME,
} from './_types.js';
import type { EdgeEvidence, EdgeKey } from './_types.js';
import {
  EdgeEvidenceStorage,
  edge_key_tuple,
} from './storage_seam.js';

// ── EdgeKey / EdgeEvidence 互转（to_dict / from_dict 同形）──

export function edge_key_to_dict(key: EdgeKey): Record<string, unknown> {
  const data: Record<string, unknown> = {
    src_type: key.src_type,
    dst_type: key.dst_type,
    src_contract_version: key.src_contract_version,
    dst_contract_version: key.dst_contract_version,
    context_domain: key.context_domain,
  };
  if (key.variant_hash !== '') {
    data['variant_hash'] = key.variant_hash;
  }
  return data;
}

export function edge_key_from_dict(data: Record<string, unknown>): EdgeKey {
  return {
    src_type: String(data['src_type'] ?? ''),
    dst_type: String(data['dst_type'] ?? ''),
    src_contract_version: String(data['src_contract_version'] ?? DEFAULT_CONTRACT_VERSION),
    dst_contract_version: String(data['dst_contract_version'] ?? DEFAULT_CONTRACT_VERSION),
    context_domain: String(data['context_domain'] ?? 'default'),
    variant_hash: String(data['variant_hash'] ?? ''),
  };
}

export function edge_evidence_to_dict(ev: EdgeEvidence): Record<string, unknown> {
  const data: Record<string, unknown> = {
    ...edge_key_to_dict(ev.key),
    success_count: ev.success_count,
    fail_count: ev.fail_count,
    avg_cost: ev.avg_cost,
    created_at: ev.created_at,
  };
  if (ev.policy) data['policy'] = true;
  if (ev.origin !== ORIGIN_RUNTIME) data['origin'] = ev.origin;
  if (ev.last_used_at !== null) data['last_used_at'] = ev.last_used_at;
  return data;
}

export function edge_evidence_from_dict(data: Record<string, unknown>): EdgeEvidence {
  const lastUsedRaw = data['last_used_at'];
  return {
    key: edge_key_from_dict(data),
    success_count: Number(data['success_count'] ?? 0),
    fail_count: Number(data['fail_count'] ?? 0),
    avg_cost: Number(data['avg_cost'] ?? 0.0),
    policy: Boolean(data['policy'] ?? false),
    origin: String(data['origin'] ?? ORIGIN_RUNTIME),
    last_used_at: lastUsedRaw === undefined || lastUsedRaw === null ? null : Number(lastUsedRaw),
    created_at: Number(data['created_at'] ?? 0.0),
  };
}

// ── 默认 in-memory seam（测试 / 无宿主注入时使用；非生产路径）──

/** 纯内存 seam；零 IO、零第三方依赖。 */
export class InMemoryEdgeEvidenceStorage implements EdgeEvidenceStorage {
  readonly #rows = new Map<string, EdgeEvidence>();

  #toKey(t: import('./storage_seam.js').EdgeKeyTuple): string {
    return t.join('::');
  }

  async get(key: import('./storage_seam.js').EdgeKeyTuple): Promise<EdgeEvidence | null> {
    const row = this.#rows.get(this.#toKey(key));
    return row === undefined ? null : { ...row, key: { ...row.key } };
  }

  async put(evidence: EdgeEvidence): Promise<EdgeEvidence> {
    const origin = evidence.policy ? ORIGIN_POLICY : evidence.origin;
    const stored: EdgeEvidence = { ...evidence, origin };
    this.#rows.set(this.#toKey(edge_key_tuple(evidence.key)), {
      ...stored,
      key: { ...stored.key },
    });
    return { ...stored, key: { ...stored.key } };
  }

  async record_success(
    key: import('./storage_seam.js').EdgeKeyTuple,
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
    const baseOrigin = existing?.origin ?? ORIGIN_RUNTIME;
    const origin = delta > 0 ? ORIGIN_RUNTIME : baseOrigin;
    const ev: EdgeEvidence = {
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
    };
    return await this.put(ev);
  }

  async record_failure(
    key: import('./storage_seam.js').EdgeKeyTuple,
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
    const baseOrigin = existing?.origin ?? ORIGIN_RUNTIME;
    const origin = delta > 0 ? ORIGIN_RUNTIME : baseOrigin;
    const ev: EdgeEvidence = {
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
    };
    return await this.put(ev);
  }

  async list_edges(domain: string | null = null): Promise<EdgeEvidence[]> {
    const rows: EdgeEvidence[] = [];
    for (const ev of this.#rows.values()) {
      if (domain === null || ev.key.context_domain === domain) {
        rows.push({ ...ev, key: { ...ev.key } });
      }
    }
    rows.sort((a, b) => {
      if (a.key.context_domain !== b.key.context_domain) {
        return a.key.context_domain < b.key.context_domain ? -1 : 1;
      }
      if (a.key.src_type !== b.key.src_type) return a.key.src_type < b.key.src_type ? -1 : 1;
      if (a.key.dst_type !== b.key.dst_type) return a.key.dst_type < b.key.dst_type ? -1 : 1;
      if (a.key.src_contract_version !== b.key.src_contract_version) {
        return a.key.src_contract_version < b.key.src_contract_version ? -1 : 1;
      }
      return a.key.dst_contract_version < b.key.dst_contract_version ? -1 : 1;
    });
    return rows;
  }

  async evidence_count(domain: string | null = null): Promise<number> {
    let n = 0;
    for (const ev of this.#rows.values()) {
      if (domain === null || ev.key.context_domain === domain) n += 1;
    }
    return n;
  }
}

/** 边证据存储（注入 seam 的薄封装；默认 in-memory，生产由宿主注入 sqlite）。 */
export class EdgeEvidenceStore {
  readonly #storage: EdgeEvidenceStorage;
  #closed = false;

  constructor(storage?: EdgeEvidenceStorage) {
    this.#storage = storage ?? new InMemoryEdgeEvidenceStorage();
  }

  async #assertOpen(): Promise<void> {
    if (this.#closed) {
      throw new StorageError('边证据存储已关闭（close() 后不可再读写）');
    }
  }

  async get(key: EdgeKey): Promise<EdgeEvidence | null> {
    await this.#assertOpen();
    try {
      return await this.#storage.get(edge_key_tuple(key));
    } catch {
      throw new StorageError('边证据读取失败（详情见日志）');
    }
  }

  async record_success(
    key: EdgeKey,
    opts: { cost?: number | null; now?: number | null; delta?: number } = {},
  ): Promise<EdgeEvidence> {
    await this.#assertOpen();
    try {
      return await this.#storage.record_success(edge_key_tuple(key), opts);
    } catch {
      throw new StorageError('边证据写入失败（并发或存储异常，详情见日志）');
    }
  }

  async record_failure(
    key: EdgeKey,
    opts: { cost?: number | null; now?: number | null; delta?: number } = {},
  ): Promise<EdgeEvidence> {
    await this.#assertOpen();
    try {
      return await this.#storage.record_failure(edge_key_tuple(key), opts);
    } catch {
      throw new StorageError('边证据写入失败（并发或存储异常，详情见日志）');
    }
  }

  async put(evidence: EdgeEvidence): Promise<EdgeEvidence> {
    await this.#assertOpen();
    try {
      return await this.#storage.put(evidence);
    } catch {
      throw new StorageError('边证据整行写入失败（详情见日志）');
    }
  }

  async list_edges(domain: string | null = null): Promise<EdgeEvidence[]> {
    await this.#assertOpen();
    try {
      return await this.#storage.list_edges(domain);
    } catch {
      throw new StorageError('边证据枚举失败（详情见日志）');
    }
  }

  async evidence_count(domain: string | null = null): Promise<number> {
    await this.#assertOpen();
    try {
      return await this.#storage.evidence_count(domain);
    } catch {
      throw new StorageError('边证据计数失败（详情见日志）');
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#storage.close !== undefined) {
      await this.#storage.close();
    }
  }
}