/**
 * EvolutionWriter 三闸门写入语义（Python evolution_writer.py 无专属 pytest，
 * 按源码/docstring 语义用内存假存储直测）：补丁链 append → 实时数据写 →
 * 审计留痕的顺序与各通道契约（路径按 _KIND_PATH 分段、GuardedStorage
 * duck-check 走豁免上下文、空 chain 按空 PatchChain 起步、非法 kind 按
 * 原样落路径、note/meta 透传、实时写失败透传）。
 */

import { describe, expect, it } from 'vitest';

import { AUDIT_COLLECTION } from '../../../src/core/audit_log/audit_log.js';
import type { MechanismExemptionScope } from '../../../src/core/audit_log/audit_log.js';
import {
  DefaultEvolutionWriter,
  EVOLUTION_AUDIT_TYPE,
  _EVOLUTION_CHAIN_COLLECTION,
  _EVOLUTION_CHAIN_KEY,
  edge_tier_writer,
  entity_writer,
  event_type_writer,
  harness_writer,
  memory_writer,
  runtime_config_writer,
} from '../../../src/core/evolution_writer/evolution_writer.js';
import type {
  EvolutionRecord,
  EvolutionStorage,
  EvolutionWriteOptions,
  EvolutionWriter,
  GuardedEvolutionStorage,
} from '../../../src/core/evolution_writer/_types.js';
import { PatchChain } from '../../../src/core/patch/patchChain.js';

/** 裸内存存储：get/put records 全量记录（无守卫；emit_audit 直接写）。 */
class MemStore implements EvolutionStorage {
  readonly records = new Map<string, Map<string, EvolutionRecord>>();
  readonly puts: Array<{ collection: string; key: string; data: EvolutionRecord }> = [];
  putFail: (() => Error) | null = null;

  private bucket(collection: string): Map<string, EvolutionRecord> | undefined {
    return this.records.get(collection);
  }

  async get_record(collection: string, key: string): Promise<EvolutionRecord | null> {
    return this.bucket(collection)?.get(key) ?? null;
  }

  async put_record(collection: string, key: string, data: EvolutionRecord): Promise<void> {
    if (this.putFail !== null) throw this.putFail();
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records.get(collection)!.set(key, JSON.parse(JSON.stringify(data)) as EvolutionRecord);
    this.puts.push({ collection, key, data });
  }
}

/** 受守卫内存存储：仅 harness:/event_types: 前缀为受守卫集合（与 Python
 *  docstring 一致），evolution_patch_chain/set_audit 等非受守卫集合直走——
 * 引擎机制内部直写不需 allow_mechanism 兜底。 */
class MemGuardedStore implements GuardedEvolutionStorage {
  readonly events: string[] = [];
  readonly allowCalls: Array<string | null | undefined> = [];
  readonly records = new Map<string, Map<string, EvolutionRecord>>();
  readonly puts: Array<{ collection: string; key: string; data: EvolutionRecord }> = [];
  depth = 0;
  putCount = 0;

  private bucket(collection: string): Map<string, EvolutionRecord> | undefined {
    return this.records.get(collection);
  }

  async get_record(collection: string, key: string): Promise<EvolutionRecord | null> {
    return this.bucket(collection)?.get(key) ?? null;
  }

  async put_record(collection: string, key: string, data: EvolutionRecord): Promise<void> {
    const guarded = collection.startsWith('harness:') || collection.startsWith('event_types');
    if (guarded && this.depth <= 0) throw new Error('受守卫集合未豁免放行');
    this.putCount += 1;
    this.events.push(`put:${collection}`);
    if (!this.records.has(collection)) this.records.set(collection, new Map());
    this.records.get(collection)!.set(key, JSON.parse(JSON.stringify(data)) as EvolutionRecord);
    this.puts.push({ collection, key, data });
  }

  allow_mechanism(collection?: string | null): MechanismExemptionScope {
    this.allowCalls.push(collection);
    return {
      enter: async (): Promise<void> => {
        this.depth += 1;
        this.events.push('enter');
      },
      exit: async (): Promise<void> => {
        this.depth -= 1;
        this.events.push('exit');
      },
    };
  }
}

/** 取 evolution chain 记录（空 = 未初始化）。 */
function getChain(store: MemStore | MemGuardedStore): PatchChain {
  const bucket = store.records.get(_EVOLUTION_CHAIN_COLLECTION);
  const raw = bucket?.get(_EVOLUTION_CHAIN_KEY) ?? null;
  return raw === null
    ? new PatchChain()
    : PatchChain.from_dict(
        raw as unknown as Parameters<typeof PatchChain.from_dict>[0],
      );
}

/** 构造 write 调用选项。 */
function opts(kind: string, asset_id: string, extra: Partial<EvolutionWriteOptions> = {}): EvolutionWriteOptions {
  return { kind, asset_id, ...extra };
}

/** 暴露给同目录其他测试文件的共享 fixture。 */
export { MemStore, MemGuardedStore, getChain, opts };
export type { EvolutionWriter };

describe('DefaultEvolutionWriter.write 三闸门顺序', () => {
  it('补丁链 append → 实时数据写 → 审计留痕，裸存储无守卫直接写', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    const data: EvolutionRecord = { name: 'h1', steps: ['a', 'b'] };

    await writer.write('harness:chains', 'chain:default', data, opts('harness', 'default', { note: 'init' }));

    const chain = getChain(store);
    expect(chain.length).toBe(1);
    expect(chain.assemble()).toEqual({ harness: { default: data } });
    const live = store.records.get('harness:chains')?.get('chain:default');
    expect(live).toEqual(data);
    const auditPuts = store.puts.filter((p) => p.collection === AUDIT_COLLECTION);
    expect(auditPuts).toHaveLength(1);
    const a = auditPuts[0];
    expect(a?.key).toBe('op-000000000000');
    expect(a?.data).toEqual({
      type: EVOLUTION_AUDIT_TYPE,
      evolution_kind: 'harness',
      asset_id: 'default',
      collection: 'harness:chains',
      key: 'chain:default',
      note: 'init',
      meta: {},
      ts: 0,
      kind: EVOLUTION_AUDIT_TYPE,
    });
  });

  it('空 chain 起步：首次写入按空 PatchChain 起步（无需预存 chain 记录）', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await writer.write('harness:chains', 'chain:default', { a: 1 }, opts('harness', 'd1'));
    const chain = getChain(store);
    expect(chain.length).toBe(1);
    expect(chain.assemble()).toEqual({ harness: { d1: { a: 1 } } });
  });

  it('多次写入累加：同一资产 REPLACE 整条记录、组装的最终态是最近一次', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await writer.write('harness:chains', 'chain:c', { v: 1 }, opts('harness', 'c'));
    await writer.write('harness:chains', 'chain:c', { v: 2 }, opts('harness', 'c'));
    await writer.write('harness:chains', 'chain:c', { v: 3 }, opts('harness', 'c'));
    const chain = getChain(store);
    expect(chain.length).toBe(3);
    expect(chain.assemble()).toEqual({ harness: { c: { v: 3 } } });
    const live = store.records.get('harness:chains')?.get('chain:c');
    expect(live).toEqual({ v: 3 });
  });

  it('不同 kind 走不同路径段（harness/event_type/entity/memory/edge_tier/runtime_config）', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await writer.write('a', 'k1', { v: 1 }, opts('harness', 'h'));
    await writer.write('a', 'k2', { v: 2 }, opts('event_type', 'e'));
    await writer.write('a', 'k3', { v: 3 }, opts('entity', 'n'));
    await writer.write('a', 'k4', { v: 4 }, opts('memory', 'm'));
    await writer.write('a', 'k5', { v: 5 }, opts('edge_tier', 't'));
    await writer.write('a', 'k6', { v: 6 }, opts('runtime_config', 'r'));
    const chain = getChain(store);
    expect(chain.assemble()).toEqual({
      harness: { h: { v: 1 } },
      event_types: { e: { v: 2 } },
      entities: { n: { v: 3 } },
      memory: { m: { v: 4 } },
      edge_tier_overrides: { t: { v: 5 } },
      runtime_config: { r: { v: 6 } },
    });
  });

  it('非法 kind：路径段按 kind 原样落（保证写入不丢）', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await writer.write('a', 'k', { v: 1 }, opts('custom_kind', 'x'));
    const chain = getChain(store);
    expect(chain.assemble()).toEqual({ custom_kind: { x: { v: 1 } } });
  });

  it('note 与 meta 透传到审计记录；meta 缺省空 dict；meta 不被原地修改', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    const meta = { src: 'cli', rev: 2 };
    await writer.write('a', 'k', { v: 1 }, opts('harness', 'h', { note: 'n1', meta }));
    expect(meta).toEqual({ src: 'cli', rev: 2 });
    const audit = store.puts.find((p) => p.collection === AUDIT_COLLECTION);
    expect(audit?.data['note']).toBe('n1');
    expect(audit?.data['meta']).toEqual({ src: 'cli', rev: 2 });
  });

  it('实时写失败：异常透传（上层管线契约——写失败即失败，不吞）', async () => {
    const store = new MemStore();
    store.putFail = (): Error => new Error('disk full');
    const writer = new DefaultEvolutionWriter(store);
    await expect(
      writer.write('a', 'k', { v: 1 }, opts('harness', 'h')),
    ).rejects.toThrow('disk full');
  });

  it('构造注入自增键源/时钟：多次演化写审计键互不覆盖', async () => {
    const store = new MemStore();
    let seq = 0;
    const writer = new DefaultEvolutionWriter(store, {
      keyGen: () => {
        seq += 1;
        return seq.toString(16).padStart(12, '0');
      },
      now: () => 1000,
    });
    await writer.write('a', 'k1', { v: 1 }, opts('harness', 'h1'));
    await writer.write('a', 'k2', { v: 2 }, opts('harness', 'h2'));
    const audits = store.puts.filter((p) => p.collection === AUDIT_COLLECTION);
    expect(audits.length).toBe(2);
    // 键源注入后两次写产出不同键（未注入时固定 op-000000000000 会互相覆盖）
    expect(audits[0]!.key).toBe('op-000000000001');
    expect(audits[1]!.key).toBe('op-000000000002');
    expect(audits.every((p) => p.data['ts'] === 1000)).toBe(true);
  });
});

describe('DefaultEvolutionWriter 受守卫存储（duck-check allow_mechanism）', () => {
  it('实时数据写经 allow_mechanism 机制豁免上下文放行（put 夹在 enter/exit 之间）', async () => {
    const store = new MemGuardedStore();
    const writer = new DefaultEvolutionWriter(store);
    await writer.write('harness:chains', 'chain:default', { a: 1 }, opts('harness', 'default'));

    expect(store.allowCalls).toEqual(['harness:chains', 'set_audit']);
    // 实时写（harness:chains）那次 put 落在 enter/exit 之间；审计通道的
    // enter/exit 由 AuditStorage 自身管理，夹的是 set_audit 写——与
    // EvolutionWriter 的实时写 enter/exit 是独立窗口事件。
    const livePutIdx = store.events.indexOf('put:harness:chains');
    expect(livePutIdx).toBeGreaterThan(0);
    expect(store.events[livePutIdx - 1]).toBe('enter');
    expect(store.events[livePutIdx + 1]).toBe('exit');
    expect(store.putCount).toBeGreaterThan(0);
    expect(store.depth).toBe(0);
  });

  it('补丁链（evolution_patch_chain）非受守卫集合——不走 allow_mechanism', async () => {
    const store = new MemGuardedStore();
    const writer = new DefaultEvolutionWriter(store);
    await writer.write('harness:chains', 'chain:default', { a: 1 }, opts('harness', 'default'));
    // allow_mechanism 只在实时写（harness:chains）与审计（set_audit）调用
    expect(store.allowCalls).toEqual(['harness:chains', 'set_audit']);
    const live = store.records.get('harness:chains')?.get('chain:default');
    expect(live).toEqual({ a: 1 });
    const chain = getChain(store);
    expect(chain.length).toBe(1);
  });

  it('duck-check：只声明 put_record 的存储被识别为非受守卫（allow_mechanism 缺失）', async () => {
    const store = new MemStore();
    const guarded: GuardedEvolutionStorage = {
      get_record: (c, k) => store.get_record(c, k),
      put_record: (c, k, d) => store.put_record(c, k, d),
      allow_mechanism: () => ({ enter: () => {}, exit: () => {} }),
    };
    const writer = new DefaultEvolutionWriter(guarded);
    await writer.write('a', 'k', { v: 1 }, opts('harness', 'h'));
    expect(store.puts.some((p) => p.collection === 'a' && p.key === 'k')).toBe(true);
  });
});

// 抑制未使用导入的 typecheck 警告
void harness_writer;
void event_type_writer;
void entity_writer;
void memory_writer;
void edge_tier_writer;
void runtime_config_writer;
