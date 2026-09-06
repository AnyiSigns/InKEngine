/**
 * Records pagination primitive tests (R7-6): sqlite and memory drivers share
 * the same semantics -- key prefix pushdown, limit + cursor paging,
 * next_cursor termination, no-args = legacy full-list semantics; GuardedStorage
 * passes the pagination primitive through.
 */

import { describe, expect, it } from 'vitest';

import { GuardedStorage } from '../../../src/core/self_application/guarded_storage.js';
import { MemoryStorage } from '../../../src/adapters/storage/memory.js';
import { SqliteStorage } from '../../../src/adapters/storage/sqlite.js';
import type { Storage } from '../../../src/core/storage/storage.js';

async function seed(storage: Storage, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1) {
    await storage.put_record('c1', keys[i]!, { idx: i, key: keys[i] });
  }
}

describe.each([
  ['memory', () => new MemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:')],
])('records pagination primitives (%s driver)', (_name, make) => {
  it('prefix pushdown + limit page + next_cursor paging + termination', async () => {
    const storage = make();
    await seed(storage, ['t-a', 't-b', 't-c', 'u-1', 'u-2', 'v']);
    const page1 = await storage.list_records_page!('c1', { prefix: 't', limit: 2 });
    expect(page1.records.map((r) => r['key'])).toEqual(['t-a', 't-b']);
    expect(page1.next_cursor).toBe('t-b');
    const page2 = await storage.list_records_page!('c1', {
      prefix: 't',
      limit: 2,
      cursor: page1.next_cursor,
    });
    expect(page2.records.map((r) => r['key'])).toEqual(['t-c']);
    expect(page2.next_cursor).toBeNull();
    await storage.close();
  });

  it('no args = legacy full-list semantics (equal to list_records)', async () => {
    const storage = make();
    await seed(storage, ['k-b', 'k-a', 'k-c']);
    const full = await storage.list_records_page!('c1', {});
    const legacy = await storage.list_records('c1');
    expect(full.records.length).toBe(legacy.length);
    expect(full.next_cursor).toBeNull();
    await storage.close();
  });

  it('cursor beyond window tail = empty page', async () => {
    const storage = make();
    await seed(storage, ['a', 'b']);
    const tail = await storage.list_records_page!('c1', { cursor: 'z', limit: 10 });
    expect(tail.records).toEqual([]);
    expect(tail.next_cursor).toBeNull();
    await storage.close();
  });
});

describe('GuardedStorage pagination passthrough', () => {
  it('delegates to the inner driver; missing driver = explicit error', async () => {
    const inner = new MemoryStorage();
    const guarded = new GuardedStorage(inner, { guarded: true });
    await seed(guarded, ['x-1', 'x-2']);
    const page = await guarded.list_records_page('c1', { prefix: 'x', limit: 1 });
    expect(page.records.map((r) => r['key'])).toEqual(['x-1']);
    expect(page.next_cursor).toBe('x-1');
    const bare = {
      list_records: async (): Promise<Record<string, unknown>[]> => [],
    } as unknown as Storage;
    const wrapper = new GuardedStorage(bare);
    await expect(wrapper.list_records_page('c1', {})).rejects.toThrow(/list_records_page/);
    await guarded.close();
  });
});
