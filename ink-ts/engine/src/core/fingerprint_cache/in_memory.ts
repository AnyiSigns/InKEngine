/**
 * 指纹缓存默认内存存储实现（InMemoryFingerprintCacheStorage）。
 *
 * 纯内存 seam：零 IO、零第三方依赖，满足无宿主注入场景零依赖运行与
 * 单测确定性；生产由宿主注入 sqlite 实现（沿 edge_evidence 同构）。
 * 行是纯 JSON 字符串形态，浅拷贝即防别名穿改（复杂字段解析归行消费者）。
 */

import type { FingerprintCacheRow, FingerprintCacheStorage } from './storage_seam.js';

/** 纯内存 seam；行级语义与 Python sqlite 实现逐条对齐。 */
export class InMemoryFingerprintCacheStorage implements FingerprintCacheStorage {
  readonly #rows = new Map<string, FingerprintCacheRow>();

  async upsert_row(row: FingerprintCacheRow): Promise<void> {
    this.#rows.set(row.context_fingerprint, { ...row });
  }

  async lookup_row(fingerprint: string): Promise<FingerprintCacheRow | null> {
    const row = this.#rows.get(fingerprint);
    return row !== undefined && row.invalid === 0 ? { ...row } : null;
  }

  async get_row(fingerprint: string): Promise<FingerprintCacheRow | null> {
    const row = this.#rows.get(fingerprint);
    return row === undefined ? null : { ...row };
  }

  async invalidate_row(fingerprint: string, ts: number): Promise<boolean> {
    const row = this.#rows.get(fingerprint);
    if (row === undefined || row.invalid === 1) return false;
    this.#rows.set(fingerprint, { ...row, invalid: 1, updated_at: ts });
    return true;
  }

  async report_hit(fingerprint: string, ts: number): Promise<boolean> {
    const row = this.#rows.get(fingerprint);
    if (row === undefined) return false;
    this.#rows.set(fingerprint, { ...row, hit_count: row.hit_count + 1, updated_at: ts });
    return true;
  }

  async report_fail(fingerprint: string, ts: number): Promise<boolean> {
    const row = this.#rows.get(fingerprint);
    if (row === undefined || row.invalid === 1) return false;
    this.#rows.set(fingerprint, {
      ...row,
      fail_count: row.fail_count + 1,
      invalid: 1,
      updated_at: ts,
    });
    return true;
  }

  async remove_row(fingerprint: string): Promise<boolean> {
    return this.#rows.delete(fingerprint);
  }

  async count_rows(domain: string | null = null): Promise<number> {
    let n = 0;
    for (const row of this.#rows.values()) {
      if (domain === null || domain === '' || row.domain === domain) n += 1;
    }
    return n;
  }

  async list_rows(domain: string | null = null): Promise<FingerprintCacheRow[]> {
    const rows: FingerprintCacheRow[] = [];
    for (const row of this.#rows.values()) {
      if (domain === null || domain === '' || row.domain === domain) rows.push({ ...row });
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