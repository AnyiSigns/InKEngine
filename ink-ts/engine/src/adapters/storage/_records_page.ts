/**
 * Records pagination/prefix pushdown shared primitives (R7-6; sqlite/memory).
 *
 * Semantics: key prefix pushdown within a collection + limit + cursor
 * (cursor = previous page tail key, strictly greater continuation), and
 * next_cursor is returned only when a further page exists. The sqlite side
 * pushes down as a key-range predicate (key >= prefix AND key < prefix end,
 * served by the records primary key index, no LIKE scan); the memory side
 * scans the same window in ascending key order.
 *
 * The prefix upper bound is the last code unit incremented (identical to
 * LIKE 'prefix%' for ASCII keys; both drivers share the same window for
 * non-ASCII keys). limit 0/negative = unbounded (legacy semantics).
 */

import type { RecordListOptions, RecordListResult } from '../../core/storage/storage.js';

/** Prefix upper bound: last code unit + 1 (null = no upper bound). */
export function prefix_upper_bound(prefix: string): string | null {
  for (let i = prefix.length - 1; i >= 0; i -= 1) {
    const code = prefix.charCodeAt(i);
    if (code < 0xffff) {
      return prefix.slice(0, i) + String.fromCharCode(code + 1);
    }
  }
  return null;
}

/** Normalized page size: invalid/absent limit = unbounded (legacy). */
export function page_limit(limit: number | null | undefined): number {
  const raw = Math.trunc(Number(limit ?? 0));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Resolve a storage row into a records dict (data column JSON parsing). */
export function record_from_row(row: { key: string; data: unknown }): Record<string, unknown> {
  const parsed = typeof row['data'] === 'string' ? JSON.parse(row['data']) : row['data'];
  return parsed as Record<string, unknown>;
}

/** Apply limit/cursor over ordered keyed rows and give the next cursor.
 *  Rows must be pre-sorted ascending and inside the prefix window; cursor
 *  semantics = keep only keys strictly greater than the cursor. */
export function slice_paged_rows<T extends { key: string }>(
  rows: readonly T[],
  cursor: string | null,
  limit: number,
): { taken: T[]; next_cursor: string | null } {
  const effectiveLimit = page_limit(limit);
  const out: T[] = [];
  for (const row of rows) {
    if (cursor !== null && cursor !== undefined && row.key <= cursor) continue;
    if (effectiveLimit > 0 && out.length >= effectiveLimit) {
      return { taken: out, next_cursor: out.length > 0 ? out[out.length - 1]!.key : null };
    }
    out.push(row);
  }
  return { taken: out, next_cursor: null };
}

/** Assemble the sqlite paged query: collection equality + prefix range +
 *  cursor offset + ascending order; fetch_more = limit + 1 (probe a next page). */
export function build_paged_sql(
  collection: string,
  opts: RecordListOptions,
): { sql: string; params: Array<string | number>; fetch_more: number } {
  const conditions = ['collection = ?'];
  const params: Array<string | number> = [collection];
  const prefix = opts.prefix ?? null;
  if (prefix !== null && prefix !== undefined && prefix !== '') {
    const upper = prefix_upper_bound(prefix);
    conditions.push('key >= ?');
    params.push(prefix);
    if (upper !== null) {
      conditions.push('key < ?');
      params.push(upper);
    }
  }
  const cursor = opts.cursor ?? null;
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    conditions.push('key > ?');
    params.push(cursor);
  }
  const limit = page_limit(opts.limit ?? null);
  const fetchMore = limit > 0 ? limit + 1 : 0;
  let sql = `SELECT key, data FROM records WHERE ${conditions.join(' AND ')} ORDER BY key`;
  if (fetchMore > 0) sql += ' LIMIT ?';
  return { sql, params: fetchMore > 0 ? [...params, fetchMore] : params, fetch_more: fetchMore };
}

/** Ascending keys of a collection map inside the prefix window. */
export function memory_keys_in_window(
  store: ReadonlyMap<string, Record<string, unknown>>,
  opts: RecordListOptions,
): string[] {
  const prefix = opts.prefix ?? null;
  const keys = [...store.keys()].sort();
  const out: string[] = [];
  for (const key of keys) {
    if (prefix !== null && prefix !== undefined && prefix !== '' && !key.startsWith(prefix)) {
      continue;
    }
    out.push(key);
  }
  return out;
}

/** Build a paged result (drivers only do row slicing + JSON restore). */
export function paged_result<T extends { key: string }>(
  rows: readonly T[],
  opts: RecordListOptions,
): RecordListResult {
  const taken = slice_paged_rows(rows, opts.cursor ?? null, page_limit(opts.limit ?? null));
  return {
    records: taken.taken.map((row) => record_from_row(row as unknown as { key: string; data: unknown })),
    next_cursor: taken.next_cursor,
  };
}
