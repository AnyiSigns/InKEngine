/**
 * 记忆默认存储后端单测（对标 ink_engine/tests/test_memory.py
 * storage-backed 段）：save/get/update/delete/query + 锁表生命周期 +
 * 召回策略注入。
 *
 * 引擎 core 零 IO：存储 seam 以注入内存假存储（records 三原语）驱动，纯
 * 机制语义与 Python create_storage("memory://") 等价；真实存储后端
 * （memory:// sqlite/postgres 宿主实现）与 asyncio 宿主 IO（跨进程并发
 * 写/事务合并）属宿主装配面，不在引擎 core 单测范围，对应集成用例按
 * 迁移纪律延后，此处以 header note 记录待办。
 */

import { describe, expect, it } from 'vitest';

import { MemoryEntry } from '../../../src/core/memory/memory.js';
import type { IdGenFn, MemoryRecallPolicy, NowFn } from '../../../src/core/memory/memory.js';
import { StorageBackedMemoryStore } from '../../../src/core/memory/store.js';
import type { StorageBackedMemoryStoreOptions } from '../../../src/core/memory/store.js';
import type { MemoryStorage } from '../../../src/core/memory/storage_seam.js';
import { _EVOLUTION_CHAIN_COLLECTION } from '../../../src/core/evolution_writer/evolution_writer.js';

/** 固定时间轴线。 */
const now: NowFn = (): number => 1000;

/** 确定性递增 id 源（每调用产出唯一 32 位 hex，满足同 ns 多条共存）。 */
let idCounter = 0;
const idGen: IdGenFn = (): string =>
  (++idCounter).toString(16).padStart(32, '0');

/** 内存假存储：records 通道三原语（put 深拷贝，隔离测试侧引用）。 */
class MemRecords implements MemoryStorage {
  readonly records = new Map<string, Map<string, Record<string, unknown>>>();

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    return this.records.get(collection)?.get(key) ?? null;
  }

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records
      .get(collection)!
      .set(key, JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    return [...(this.records.get(collection)?.values() ?? [])];
  }

  record(collection: string, key: string): Record<string, unknown> | undefined {
    return this.records.get(collection)?.get(key);
  }
}

/** 构造存储（默认固定时间轴/固定 id；可注入选项）。 */
function makeStore(options: StorageBackedMemoryStoreOptions = {}): {
  store: StorageBackedMemoryStore;
  mem: MemRecords;
} {
  idCounter = 0; // 每个 store 从同一确定性序列起步
  const mem = new MemRecords();
  const store = new StorageBackedMemoryStore(mem, 'memory', { now, id_gen: idGen, ...options });
  return { store, mem };
}

/** 构造条目（缺省 book:1/plot/c，created_at 走固定时间轴）。 */
function _entry(
  overrides: {
    namespace?: string;
    kind?: string;
    content?: string;
    priority?: number;
    source?: string;
    created_at?: number;
    expires_at?: number | null;
    id?: string | null;
  } = {},
): MemoryEntry {
  return new MemoryEntry({
    namespace: 'book:1',
    kind: 'plot',
    content: 'c',
    priority: 5,
    created_at: now(),
    ...overrides,
  });
}

describe('StorageBackedMemoryStore：save/get/update', () => {
  it('save 生成 id（namespace:hex）并落库，get 往返一致', async () => {
    const { store } = makeStore();
    const eid = await store.save(
      new MemoryEntry({ namespace: 'book:7', kind: 'plot', content: '摘要', priority: 4, created_at: now() }),
    );
    expect(eid).toBe(`book:7:${'0'.repeat(31)}1`);
    const got = await store.get(eid);
    expect(got).not.toBeNull();
    expect(got!.content).toBe('摘要');
    expect(got!.namespace).toBe('book:7');
  });

  it('save 沿用条目自带 id（Python `or` 语义：非空即用）', async () => {
    const { store } = makeStore();
    const eid = await store.save(_entry({ id: 'fixed-1' }));
    expect(eid).toBe('fixed-1');
  });

  it('update 改动可写字段；身份字段（namespace/created_at）不可变', async () => {
    const { store } = makeStore();
    const eid = await store.save(_entry({ namespace: 'book:7', content: '旧', created_at: 100 }));
    const before = await store.get(eid);
    const ok = await store.update(eid, { content: '新摘要', priority: 8, id: 'hack', namespace: 'evil' });
    expect(ok).toBe(true);
    const updated = await store.get(eid);
    expect(updated!.content).toBe('新摘要');
    expect(updated!.priority).toBe(8);
    expect(updated!.id).toBe(eid);
    expect(updated!.namespace).toBe('book:7'); // 身份字段不受 data 覆盖
    expect(updated!.created_at).toBe(before!.created_at);
  });

  it('update 不存在的条目返回 false（含已删除标记）', async () => {
    const { store } = makeStore();
    expect(await store.update('missing', { content: 'x' })).toBe(false);
    const eid = await store.save(_entry());
    await store.delete(eid);
    expect(await store.update(eid, { content: 'x' })).toBe(false);
  });

  it('并发 update 同 key 串行化：读-改-写不丢更新', async () => {
    const { store } = makeStore();
    const eid = await store.save(_entry());
    await Promise.all([
      store.update(eid, { content: 'a' }),
      store.update(eid, { priority: 9 }),
    ]);
    const got = await store.get(eid);
    expect(got!.content).toBe('a');
    expect(got!.priority).toBe(9);
  });
});

describe('StorageBackedMemoryStore：非破坏性删除', () => {
  it('delete 标记 _deleted：get 失效、query 不再返回、记录仍可追溯', async () => {
    const { store, mem } = makeStore();
    const eid = await store.save(_entry({ kind: 'style', content: '偏好' }));
    expect(await store.delete(eid)).toBe(true);
    expect(await store.get(eid)).toBeNull();
    expect(await store.query({ kind: 'style' })).toEqual([]);
    const raw = mem.record('memory', eid);
    expect(raw).not.toBeNull();
    expect(raw!['_deleted']).toBe(true); // 物理记录保留（Event Sourcing 可追溯）
  });

  it('delete 不存在的条目返回 false', async () => {
    const { store } = makeStore();
    expect(await store.delete('missing')).toBe(false);
  });
});

describe('StorageBackedMemoryStore：查询过滤与召回排序', () => {
  it('query 按 namespace/kind/source 过滤，默认优先级降序 + limit 截断', async () => {
    const { store } = makeStore();
    await store.save(_entry({ namespace: 'book:1', kind: 'plot', source: 'a', priority: 3 }));
    await store.save(_entry({ namespace: 'book:1', kind: 'plot', source: 'b', priority: 7 }));
    await store.save(_entry({ namespace: 'book:2', kind: 'style', source: 'a', priority: 5 }));

    const by_source = await store.query({ namespace: 'book:1', source: 'a' });
    expect(by_source).toHaveLength(1);
    expect(by_source[0]!.source).toBe('a');

    const by_kind = await store.query({ kind: 'plot', limit: 1 });
    expect(by_kind).toHaveLength(1);
    expect(by_kind[0]!.priority).toBe(7); // 存储边界内已按 priority 降序
  });

  it('query 排除时效失效条目（is_expired 在存储边界过滤）', async () => {
    const { store } = makeStore();
    await store.save(_entry({ content: 'alive' }));
    await store.save(_entry({ content: 'dead', expires_at: now() - 1 }));
    const got = await store.query({});
    expect(got).toHaveLength(1);
    expect(got[0]!.content).toBe('alive');
  });

  it('注入自定义召回策略：判据单点生效（存储不再二次排序）', async () => {
    const reversed: MemoryRecallPolicy = {
      recall: (entries, options) => {
        const out = [...entries].sort((a, b) => a.priority - b.priority);
        const limit = options?.limit ?? null;
        return limit !== null ? out.slice(0, limit) : out;
      },
    };
    const { store } = makeStore({ recall_policy: reversed });
    await store.save(_entry({ priority: 3 }));
    await store.save(_entry({ priority: 9 }));
    const got = await store.query({});
    expect(got.map((entry) => entry.priority)).toEqual([3, 9]);
  });
});

describe('per-key 锁表生命周期（内存泄漏防护语义）', () => {
  it('update 创建锁，delete 移除锁，重建同 id 走新锁', async () => {
    const { store } = makeStore();
    const eid = await store.save(_entry());
    await store.update(eid, { content: 'x' }); // 读-改-写路径创建锁
    expect(store._locks.has(eid)).toBe(true);
    await store.delete(eid);
    expect(store._locks.has(eid)).toBe(false);
    // 重建同 id 条目走新锁（锁表无状态残留）
    const again = await makeStore();
    await again.store.update(eid, { content: 'y' });
    expect(again.store._locks.has(eid)).toBe(true);
  });

  it('全部记录写入经 EvolutionWriter 管线（补丁链 + 审计留痕）', async () => {
    const { store, mem } = makeStore();
    const eid = await store.save(_entry());
    await store.update(eid, { content: 'v2' });
    expect(mem.record(_EVOLUTION_CHAIN_COLLECTION, 'chain')).not.toBeNull();
    expect(mem.records.has('set_audit')).toBe(true); // 审计留痕落 set_audit 集合
  });
});