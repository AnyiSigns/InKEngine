/**
 * 指纹缓存的 records 通道存储（FingerprintCacheStorage 的受控持久化实现）。
 *
 * 引擎自承载持久化：宿主注入 Storage（sqlite 由宿主驱动），缓存行以
 * 记录集合形态落库——键 = context_fingerprint（与主键约束同口径），值 =
 * 表行全量字段（复杂字段保持稳定 JSON 字符串形态，与行语义一致）。
 * 读写全部经 Storage seam 进出，core 零 IO；记录集合非演化资产集合。
 */

import type { FingerprintCacheRow, FingerprintCacheStorage } from './storage_seam.js';
import type { Storage } from '../storage/storage.js';

/** 指纹缓存持久化集合（records 通道普通命名空间，非受守卫演化资产集合）。 */
export const FINGERPRINT_CACHE_COLLECTION = 'fingerprint_cache';

/** 记录 → 行（值字段即行字段；JSON 字符串复杂字段原样透传）。 */
function _row_of(record: Record<string, unknown>): FingerprintCacheRow {
  return {
    context_fingerprint: String(record['context_fingerprint'] ?? ''),
    path_data: String(record['path_data'] ?? ''),
    path_fingerprint: String(record['path_fingerprint'] ?? ''),
    evidence_snapshot: String(record['evidence_snapshot'] ?? ''),
    contract_snapshot: String(record['contract_snapshot'] ?? ''),
    model_id: String(record['model_id'] ?? ''),
    domain: String(record['domain'] ?? 'default'),
    created_at: Number(record['created_at'] ?? 0),
    updated_at: Number(record['updated_at'] ?? 0),
    hit_count: Math.trunc(Number(record['hit_count'] ?? 0)),
    fail_count: Math.trunc(Number(record['fail_count'] ?? 0)),
    invalid: Number(record['invalid'] ?? 0) === 1 ? 1 : 0,
  };
}

/** 行 → 记录（省略列不存在键，读取侧由 _row_of 兜底缺省）。 */
function _record_of(row: FingerprintCacheRow): Record<string, unknown> {
  return { ...row };
}

/** records 通道的指纹缓存存储（Storage 注入；集合名可按集隔离覆写）。 */
export class RecordsFingerprintCacheStorage implements FingerprintCacheStorage {
  readonly #storage: Storage;
  readonly #collection: string;

  constructor(storage: Storage, opts: { collection?: string } = {}) {
    this.#storage = storage;
    this.#collection = opts.collection ?? FINGERPRINT_CACHE_COLLECTION;
  }

  async upsert_row(row: FingerprintCacheRow): Promise<void> {
    await this.#storage.put_record(
      this.#collection,
      row.context_fingerprint,
      _record_of(row),
    );
  }

  async lookup_row(fingerprint: string): Promise<FingerprintCacheRow | null> {
    const row = await this.get_row(fingerprint);
    return row !== null && row.invalid === 0 ? row : null;
  }

  async get_row(fingerprint: string): Promise<FingerprintCacheRow | null> {
    const record = await this.#storage.get_record(this.#collection, fingerprint);
    if (record === null || record === undefined) return null;
    return _row_of(record);
  }

  async #put_row(row: FingerprintCacheRow): Promise<void> {
    await this.upsert_row(row);
  }

  async invalidate_row(fingerprint: string, ts: number): Promise<boolean> {
    const row = await this.get_row(fingerprint);
    if (row === null || row.invalid === 1) return false;
    await this.#put_row({ ...row, invalid: 1, updated_at: ts });
    return true;
  }

  async report_hit(fingerprint: string, ts: number): Promise<boolean> {
    const row = await this.get_row(fingerprint);
    if (row === null) return false;
    await this.#put_row({ ...row, hit_count: row.hit_count + 1, updated_at: ts });
    return true;
  }

  async report_fail(fingerprint: string, ts: number): Promise<boolean> {
    const row = await this.get_row(fingerprint);
    if (row === null || row.invalid === 1) return false;
    await this.#put_row({
      ...row,
      fail_count: row.fail_count + 1,
      invalid: 1,
      updated_at: ts,
    });
    return true;
  }

  async remove_row(fingerprint: string): Promise<boolean> {
    // records 通道无单条删除原语：物理移除 = 顶替为 tombstone 后由
    // count/list 读取侧过滤（读取侧视 tombstone 为不存在行）。
    const row = await this.get_row(fingerprint);
    if (row === null) return false;
    await this.#put_row({ ...row, invalid: 1, updated_at: 0 });
    return true;
  }

  async count_rows(domain: string | null = null): Promise<number> {
    return (await this.list_rows(domain)).length;
  }

  async list_rows(domain: string | null = null): Promise<FingerprintCacheRow[]> {
    const rows: FingerprintCacheRow[] = [];
    for (const record of await this.#storage.list_records(this.#collection)) {
      const row = _row_of(record);
      if (row.invalid === 1) continue; // tombstone（remove_row 语义）不可见
      if (domain === null || domain === '' || row.domain === domain) rows.push(row);
    }
    rows.sort((a, b) => {
      if (a.context_fingerprint !== b.context_fingerprint) {
        return a.context_fingerprint < b.context_fingerprint ? -1 : 1;
      }
      return 0;
    });
    return rows;
  }
}
