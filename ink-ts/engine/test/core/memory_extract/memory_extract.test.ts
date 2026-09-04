/**
 * 记忆无感提取（零 LLM 规则抽取）+ 冲突消解（新旧并存留痕）单测
 * （对标 ink_engine/tests/test_memory_extract.py）。
 *
 * 引擎 core 零 IO：存储 seam 以注入内存假存储（records 三原语）驱动，
 * 纯机制语义与 Python MemoryStorage() 内存存储等价；真实存储后端
 * （memory:// sqlite/postgres 宿主实现）与 asyncio 宿主 IO（跨进程并发
 * 写/事务合并）属宿主装配面，不在引擎 core 单测范围，对应集成用例按
 * 迁移纪律延后，此处以 header note 记录待办。
 */

import { describe, expect, it } from 'vitest';

import type { JsonRecord } from '../../../src/core/json.js';
import type { IdGenFn, NowFn } from '../../../src/core/memory/memory.js';
import { StorageBackedMemoryStore } from '../../../src/core/memory/store.js';
import type { StorageBackedMemoryStoreOptions } from '../../../src/core/memory/store.js';
import type { MemoryStorage } from '../../../src/core/memory/storage_seam.js';
import {
  CONFIRMATION_EVENTS,
  PRIORITY_CONCLUSION,
  PRIORITY_CONFIRMATION,
  PRIORITY_INTENT,
  ROUND_FACT_EVENTS,
  arbitrate_and_store,
  extract_entries_from_ledger,
} from '../../../src/core/memory_extract/memory_extract.js';

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
      .set(key, JSON.parse(JSON.stringify(data)) as JsonRecord);
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    return [...(this.records.get(collection)?.values() ?? [])];
  }
}

/** 构造存储（固定时间轴/确定性 id 源，等价 Python MemoryStorage()）。 */
function makeStore(options: StorageBackedMemoryStoreOptions = {}): StorageBackedMemoryStore {
  idCounter = 0;
  return new StorageBackedMemoryStore(new MemRecords(), 'memory', { now, id_gen: idGen, ...options });
}

describe('memory_extract：抽取意图/结论/确认三类条目', () => {
  it('intent/conclusion/confirmation 各落一条，确认内容取自事件 detail', () => {
    const ledger: JsonRecord = {
      round_id: 'r1',
      intent: '帮我把灯关了',
      conclusion: '已关闭灯光',
      events: [
        { kind: 'tool_end', detail: { path: 'a.rs' } },
        { kind: 'accept', detail: { content: '确认关灯' } },
      ],
    };
    const entries = extract_entries_from_ledger(ledger);
    const kinds = new Set(entries.map((entry) => entry.kind));
    expect(kinds.has('intent')).toBe(true);
    expect(kinds.has('conclusion')).toBe(true);
    expect(kinds.has('confirmation')).toBe(true);
    const confirm = entries.find((entry) => entry.kind === 'confirmation')!;
    expect(confirm.content).toContain('确认关灯');
  });
});

describe('memory_extract：确认类事件口径契约', () => {
  it('确认类事件 = 真实引擎事件类型，⊆ 账本事实全集，虚构类型已移除', () => {
    // 与壳侧账本归约保留集同源，防账本漏确认类 → 记忆抽不到
    expect(new Set(CONFIRMATION_EVENTS)).toEqual(
      new Set(['accept', 'edit', 'reject', 'user_correction', 'user_confirm']),
    );
    // 确认类 ⊆ 账本事实事件全集（壳侧 RECOGNIZED_EVENTS 引用 ROUND_FACT_EVENTS）
    expect(CONFIRMATION_EVENTS.every((kind) => ROUND_FACT_EVENTS.includes(kind))).toBe(true);
    // 历史虚构类型已移除（approval_accept 非真实引擎事件类型）
    expect(CONFIRMATION_EVENTS).not.toContain('approval_accept');
    expect(CONFIRMATION_EVENTS).not.toContain('confirmation');
  });
});

describe('memory_extract：抽取优先级数据化', () => {
  it('缺省 = 模块常量（确认类 > 意图 > 结论），宿主可覆盖', () => {
    // ENG1-13：抽取优先级数据化（旧硬编码 6/5/7）——缺省 = 模块常量，
    // 宿主可覆盖；语义：确认类 > 意图 > 结论
    const ledger: JsonRecord = {
      round_id: 'r1',
      intent: '意图',
      conclusion: '结论',
      events: [{ kind: 'user_confirm', detail: { content: '确认' } }],
    };
    const entries = extract_entries_from_ledger(ledger);
    const by_kind = new Map(entries.map((entry) => [entry.kind, entry.priority] as const));
    expect(Object.fromEntries(by_kind)).toEqual({
      intent: PRIORITY_INTENT,
      conclusion: PRIORITY_CONCLUSION,
      confirmation: PRIORITY_CONFIRMATION,
    });
    expect(PRIORITY_CONFIRMATION > PRIORITY_INTENT && PRIORITY_INTENT > PRIORITY_CONCLUSION).toBe(true);
    expect(by_kind.get('intent')).toBe(6);
    expect(by_kind.get('conclusion')).toBe(5);
    expect(by_kind.get('confirmation')).toBe(7);
    // 宿主覆盖生效
    const custom = extract_entries_from_ledger(ledger, {
      priority_intent: 9,
      priority_conclusion: 1,
      priority_confirmation: 5,
    });
    const custom_by_kind = new Map(custom.map((entry) => [entry.kind, entry.priority] as const));
    expect(custom_by_kind.get('intent')).toBe(9);
    expect(custom_by_kind.get('conclusion')).toBe(1);
    expect(custom_by_kind.get('confirmation')).toBe(5);
  });
});

describe('memory_extract：仲裁去重（同内容跳过存储）', () => {
  it('重复抽取同内容 → 不重复落库', async () => {
    const store = makeStore();
    const ledger: JsonRecord = { round_id: 'r1', intent: '同一意图', conclusion: null, events: [] };
    const entries = extract_entries_from_ledger(ledger);
    const r1 = await arbitrate_and_store(store, entries);
    // 重复抽取同内容 → 跳过存储（不重复落库）
    const r2 = await arbitrate_and_store(store, entries);
    expect(r1.stored).toHaveLength(1);
    expect(r2.stored).toHaveLength(0);
    expect(r2.skipped).toHaveLength(1);
  });
});

describe('memory_extract：仲裁冲突新旧并存留痕（不静默覆盖）', () => {
  it('同 namespace+kind 内容冲突 → coexist 互写溯源，旧条目保留', async () => {
    const store = makeStore();
    // 第一条意图
    const e1 = extract_entries_from_ledger({ intent: '旧意图', conclusion: null, events: [] } as JsonRecord);
    const r1 = await arbitrate_and_store(store, e1);
    expect(r1.stored).toHaveLength(1);
    // 冲突内容（同 namespace+kind，内容不同）→ 新旧并存留痕
    const e2 = extract_entries_from_ledger({ intent: '新意图', conclusion: null, events: [] } as JsonRecord);
    const r2 = await arbitrate_and_store(store, e2);
    expect(r2.stored).toHaveLength(1);
    expect(r2.arbitrations).toHaveLength(1);
    const arb = r2.arbitrations[0]!;
    expect(arb.action).toBe('coexist');
    expect(arb.new_id).not.toBe(arb.old_id);
    // 旧条目仍在（未被静默覆盖），且双方互留溯源
    const old_id = arb.old_id;
    const old_rec = await store.get(old_id);
    expect(old_rec).not.toBeNull();
    expect(String(old_rec!.meta['arbitration'] ?? '')).toMatch(/^coexist:/);
    const new_rec = await store.get(arb.new_id);
    expect(new_rec).not.toBeNull();
    expect(String(new_rec!.meta['arbitration'] ?? '')).toMatch(/^coexist:/);
  });
});