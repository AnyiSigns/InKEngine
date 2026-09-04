/**
 * MemoryStorage ???? + structured records ????? pytest
 * test_storage.py ? memory:// ??/??????
 *
 * ???append seq ??/???????events_after ?????/??/
 * latest ????? payload ???????? append ? seq ?????
 * ?ENG2-4/16????????????records CRUD/upsert/????/
 * ?????/?????/? JSON ???
 */

import { describe, expect, it } from 'vitest';

import { EngineEvent } from '../../../src/core/events/events.js';
import { StorageError } from '../../../src/core/errors.js';
import type { JsonRecord } from '../../../src/core/json.js';
import { MemoryStorage } from '../../../src/adapters/storage/memory.js';

function ev(type: string, payload: JsonRecord = {}): EngineEvent {
  return new EngineEvent({ type, payload });
}

describe('???? append + ??', () => {
  it('append seq ????????????????? seq?', async () => {
    const store = new MemoryStorage();
    const e1 = new EngineEvent({ type: 'reply_token', payload: { text: 'a' }, seq: 1 });
    const e2 = new EngineEvent({ type: 'reply_token', payload: { text: 'b' }, seq: 2 });
    const s1 = await store.append_event('t1', e1);
    const s2 = await store.append_event('t1', e2);
    expect(s1).toBeLessThan(s2);
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    const after = await store.events_after('t1', 0);
    expect(after.map((e) => e.type)).toEqual(['reply_token', 'reply_token']);
    expect(after.map((e) => e.seq)).toEqual([s1, s2]);
    await store.close();
  });

  it('events_after ? seq ??????????', async () => {
    const store = new MemoryStorage();
    await store.append_event('t1', ev('a'));
    await store.append_event('t2', ev('b'));
    expect(await store.events_after('t1', 0)).toHaveLength(1);
    expect(await store.events_after('missing', 0)).toEqual([]);
    await store.close();
  });

  it('latest_event_seq ?? + ?????', async () => {
    const store = new MemoryStorage();
    const s1 = await store.append_event('t1', ev('a'));
    const s2 = await store.append_event('t1', ev('b'));
    await store.append_event('t2', ev('c'));
    expect(await store.latest_event_seq('t1')).toBe(s2);
    expect(await store.latest_event_seq('t2')).toBe(s2 + 1);
    expect(await store.latest_event_seq('t3')).toBe(0);
    await store.truncate_events('t1', s1);
    expect(await store.latest_event_seq('t1')).toBe(s1);
    const after = await store.events_after('t1', 0);
    expect(after).toHaveLength(1);
    expect(after[0]!.seq).toBe(s1);
    await store.close();
  });

  it('trim_events ?? seq <= before_seq???????', async () => {
    const store = new MemoryStorage();
    const s1 = await store.append_event('t1', ev('a'));
    const s2 = await store.append_event('t1', ev('b'));
    const s3 = await store.append_event('t1', ev('c'));
    expect(await store.trim_events('t1', s1)).toBe(1);
    expect((await store.events_after('t1', 0)).map((e) => e.seq)).toEqual([s2, s3]);
    expect(await store.trim_events('missing', 5)).toBe(0);
    await store.close();
  });

  it('?? append seq ?????????? + ?????', async () => {
    const store = new MemoryStorage();
    const hammer = async (tag: string, count: number): Promise<number[]> => {
      const seqs: number[] = [];
      for (let i = 0; i < count; i++) {
        seqs.push(
          await store.append_event('t-conc', new EngineEvent({ type: 't', payload: { tag, i } })),
        );
      }
      return seqs;
    };
    const groups = await Promise.all([
      hammer('a', 10),
      hammer('b', 10),
      hammer('c', 10),
      hammer('d', 10),
    ]);
    const flat = groups.flat();
    expect(new Set(flat).size).toBe(flat.length);
    for (const group of groups) {
      expect(group).toEqual([...group].sort((a, b) => a - b));
    }
    expect(await store.events_after('t-conc', 0)).toHaveLength(40);
    await store.close();
  });

  it('?? payload ??????????', async () => {
    const store = new MemoryStorage();
    await store.append_event(
      't1',
      ev('review_card', { review: 'ok', api_key: 'sk-secret', nested: { token: 't', keep: 1 } }),
    );
    const after = await store.events_after('t1', 0);
    const payload = after[0]!.payload as Record<string, unknown>;
    expect(payload.api_key).toBe('');
    expect(payload.review).toBe('ok');
    expect((payload.nested as Record<string, unknown>).token).toBe('');
    expect((payload.nested as Record<string, unknown>).keep).toBe(1);
    await store.close();
  });

  it('??????????????????????', async () => {
    const store = new MemoryStorage();
    await store.append_event('t1', ev('a', { items: [1] }));
    const got = await store.events_after('t1', 0);
    (got[0]!.payload as { items: number[] }).items.push(2);
    const again = await store.events_after('t1', 0);
    expect((again[0]!.payload as { items: number[] }).items).toEqual([1]);
    await store.close();
  });
});

describe('structured records', () => {
  it('CRUD/upsert/missing/????', async () => {
    const store = new MemoryStorage();
    await store.put_record('memory', 'k1', { a: 1 });
    expect(await store.get_record('memory', 'k1')).toEqual({ a: 1 });
    await store.put_record('memory', 'k1', { a: 2 });
    expect(await store.get_record('memory', 'k1')).toEqual({ a: 2 });
    expect(await store.get_record('memory', 'missing')).toBeNull();
    await store.put_record('other', 'k1', { b: 3 });
    expect(await store.list_records('memory')).toEqual([{ a: 2 }]);
    expect(await store.delete_collection('memory')).toBe(1);
    expect(await store.delete_collection('memory')).toBe(0);
    expect(await store.delete_collection('none')).toBe(0);
    expect(await store.list_records('other')).toHaveLength(1);
    await store.close();
  });

  it('????????/????????', async () => {
    const store = new MemoryStorage();
    await store.put_record('memory', 'k1', { token: 'sk-secret', keep: 1 });
    const got = await store.get_record('memory', 'k1');
    expect(got?.token).toBe('');
    expect(got?.keep).toBe(1);
    await store.close();
  });

  it('? JSON ?????StorageError???????', async () => {
    const store = new MemoryStorage();
    class _Obj {}
    await expect(
      store.put_record('memory', 'k1', { obj: new _Obj() } as never),
    ).rejects.toThrow(StorageError);
    await store.close();
  });

  it('????????????/????????', async () => {
    const store = new MemoryStorage();
    const input = { items: [1] };
    await store.put_record('c', 'k', input);
    input.items.push(9);
    const got = await store.get_record('c', 'k');
    (got as { items: number[] }).items.push(2);
    expect((await store.get_record('c', 'k'))?.items).toEqual([1]);
    await store.close();
  });
});
