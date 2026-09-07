/**
 * 回合记忆抽取 settle 钩子单测：MemoryExtractSettleHook 按回合触发、
 * 同 round 幂等、确认类事件有输入、存储失败不击穿。
 */

import { describe, expect, it } from 'vitest';

import type { JsonRecord } from '../../../src/core/json.js';
import type { IdGenFn, NowFn } from '../../../src/core/memory/memory.js';
import { MemoryEntry, StorageBackedMemoryStore } from '../../../src/core/memory/index.js';
import type { StorageBackedMemoryStoreOptions } from '../../../src/core/memory/index.js';
import type { MemoryStorage } from '../../../src/core/memory/storage_seam.js';
import {
  DEFAULT_NAMESPACE,
  MemoryExtractSettleHook,
  extract_entries_from_ledger,
} from '../../../src/kernel/memory_extract/index.js';
import type { SettleContext } from '../../../src/kernel/settle/index.js';

/** 固定时间轴线（条目 created_at 确定可断言）。 */
const now: NowFn = (): number => 1000;

/** 确定性递增 id 源（每次调用产出唯一 32 位 hex，满足同 ns 多条共存）。 */
let idCounter = 0;
const idGen: IdGenFn = (): string => (++idCounter).toString(16).padStart(32, '0');

/** 内存假存储：records 通道三原语（put 深拷贝，隔离测试侧引用）。 */
class MemRecords implements MemoryStorage {
  readonly records = new Map<string, Map<string, Record<string, unknown>>>();

  async get_record(collection: string, key: string): Promise<Record<string, unknown> | null> {
    return this.records.get(collection)?.get(key) ?? null;
  }

  async put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records.get(collection)!.set(key, JSON.parse(JSON.stringify(data)) as JsonRecord);
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    return [...(this.records.get(collection)?.values() ?? [])];
  }
}

/** 构造存储（固定时间轴/确定性 id 源，等价 Python MemoryStorage()）。 */
function makeStore(options: StorageBackedMemoryStoreOptions = {}): StorageBackedMemoryStore {
  idCounter = 0;
  return new StorageBackedMemoryStore(new MemRecords(), 'memory', {
    now,
    id_gen: idGen,
    ...options,
  });
}

/** settle 假上下文（钩子只读 thread/round + facts 提供者入参）。 */
function fakeCtx(round_id: string, thread = 't1'): SettleContext {
  return { thread_id: thread, round_id } as unknown as SettleContext;
}

describe('memory_extract settle 钩子：回合收尾抽取', () => {
  it('确认/意图/结论抽取入 memory 域（确认类事件有真实输入）', async () => {
    const store = makeStore();
    const hook = new MemoryExtractSettleHook(store, {
      facts: () => ({
        round_id: 'r1',
        intent: '去关灯',
        conclusion: '已关灯',
        events: [{ kind: 'accept', detail: { content: '确认关灯' } }],
      }),
    });
    await hook.settle(fakeCtx('r1'));
    const intents = await store.query({ namespace: DEFAULT_NAMESPACE, kind: 'intent' });
    const conclusions = await store.query({
      namespace: DEFAULT_NAMESPACE,
      kind: 'conclusion',
    });
    const confirmations = await store.query({
      namespace: DEFAULT_NAMESPACE,
      kind: 'confirmation',
    });
    expect(intents.map((e) => e.content)).toContain('去关灯');
    expect(conclusions.map((e) => e.content)).toContain('已关灯');
    expect(confirmations.length).toBe(1);
    expect(String(confirmations[0]!.meta['ledger_round'])).toBe('r1');
  });

  it('同 thread 同 round 幂等：二次 settle 不重复抽取', async () => {
    const store = makeStore();
    const hook = new MemoryExtractSettleHook(store, {
      facts: () => ({ round_id: 'r1', intent: '同一意图', events: [] }),
    });
    await hook.settle(fakeCtx('r1'));
    await hook.settle(fakeCtx('r1'));
    const intents = await store.query({ namespace: DEFAULT_NAMESPACE, kind: 'intent' });
    expect(intents.length).toBe(1);
  });

  it('不同 round 各自抽取（内容去重沿用仲裁，不同内容并存）', async () => {
    const store = makeStore();
    let round = 'r1';
    const hook = new MemoryExtractSettleHook(store, {
      facts: () => ({ round_id: round, intent: `意图${round}` }),
    });
    await hook.settle(fakeCtx('r1'));
    round = 'r2';
    await hook.settle(fakeCtx('r2'));
    const intents = await store.query({ namespace: DEFAULT_NAMESPACE, kind: 'intent' });
    expect(intents.length).toBe(2);
  });

  it('无记录回合（facts null / 无字段）跳过；存储失败不抛出', async () => {
    const store = makeStore();
    const hook = new MemoryExtractSettleHook(store, { facts: () => null });
    await expect(hook.settle(fakeCtx('r9'))).resolves.toBeUndefined();
    expect((await store.query({})).length).toBe(0);
  });

  it('extract_entries_from_ledger 确认类事件的 detail 内容透传', async () => {
    const entries = extract_entries_from_ledger({
      round_id: 'r1',
      intent: 'x',
      conclusion: null,
      events: [{ kind: 'user_confirm', detail: { content: '就是它' } }],
    });
    const confirm = entries.find((e) => e.kind === 'confirmation');
    expect(confirm).toBeInstanceOf(MemoryEntry);
    expect(confirm!.content).toBe('就是它');
  });
});
