/** audit_log 落库语义（Python audit_log.py 无专属 pytest，按源码/docstring
 *  语义用内存假存储直测）：合并 ts/kind、'op-<hex>' 键、豁免上下文放行、
 *  storage=None 静默跳过、缺 put_record / 任意写失败一律不抛。 */

import { describe, expect, it } from 'vitest';

import {
  AUDIT_COLLECTION,
  type AuditRecord,
  type AuditStorage,
  type GuardedAuditStorage,
  type MechanismExemptionScope,
  emit_audit,
} from '../../../src/core/audit_log/audit_log.js';

/** 裸内存存储：记录全部 put 调用（无守卫，直接写）。 */
class MemAuditStore implements AuditStorage {
  puts: Array<{ collection: string; key: string; data: AuditRecord }> = [];

  async put_record(collection: string, key: string, data: AuditRecord): Promise<void> {
    this.puts.push({ collection, key, data });
  }

  rowsOf(collection: string): Array<{ key: string; data: AuditRecord }> {
    return this.puts.filter((p) => p.collection === collection);
  }
}

/** 受守卫内存存储：豁免窗口未开（depth<=0）时写失败——验证 put 确被夹在
 *  enter/exit 之间；同时留事件序列与 allow_mechanism 调用参数。 */
class MemGuardedStore implements GuardedAuditStorage {
  readonly events: string[] = [];
  readonly allowCalls: Array<string | null | undefined> = [];
  depth = 0;
  putCount = 0;

  async put_record(collection: string, key: string, data: AuditRecord): Promise<void> {
    if (this.depth <= 0) throw new Error('受守卫集合未豁免放行');
    this.putCount += 1;
    this.events.push(`put:${collection}`);
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

describe('emit_audit 落库（裸存储直接写）', () => {
  it('写 set_audit 集合、op-<hex> 键、合并 ts(缺省 0)/kind(type)', async () => {
    const store = new MemAuditStore();
    await emit_audit(store, {
      type: 'candidate_selection',
      op: 'select',
      payload: { path: 'a.ts' },
    });
    expect(store.puts).toHaveLength(1);
    const put = store.puts[0];
    expect(put?.collection).toBe(AUDIT_COLLECTION);
    expect(put?.collection).toBe('set_audit');
    expect(put?.key).toBe('op-000000000000');
    expect(put?.data).toEqual({
      type: 'candidate_selection',
      op: 'select',
      payload: { path: 'a.ts' },
      ts: 0,
      kind: 'candidate_selection',
    });
  });

  it('ts 已随记录（含 0）时原样保留，不取注入 now', async () => {
    const store = new MemAuditStore();
    let nowCalls = 0;
    await emit_audit(store, { type: 'junction_switch', ts: 123.5 }, { now: () => (nowCalls += 1) });
    await emit_audit(store, { type: 'junction_switch', ts: 0 });
    const tsValues = store.puts.map((p) => p.data['ts']);
    expect(tsValues).toEqual([123.5, 0]);
    expect(nowCalls).toBe(0);
  });

  it('ts 缺失（或为 null）时取注入 now', async () => {
    const store = new MemAuditStore();
    const injectNow = (): number => 42.5;
    await emit_audit(store, { type: 'x' }, { now: injectNow });
    await emit_audit(store, { type: 'x', ts: null }, { now: injectNow });
    expect(store.puts.map((p) => p.data['ts'])).toEqual([42.5, 42.5]);
  });

  it('kind 取 type；type 缺失/空值/0 回落 op', async () => {
    const store = new MemAuditStore();
    await emit_audit(store, { type: 'policy_review' });
    await emit_audit(store, {});
    await emit_audit(store, { type: null });
    await emit_audit(store, { type: '' });
    await emit_audit(store, { type: 0 });
    expect(store.puts.map((p) => p.data['kind'])).toEqual([
      'policy_review',
      'op',
      'op',
      'op',
      'op',
    ]);
  });

  it('keyGen 注入控制键片段（缺省前缀 op- 保留）', async () => {
    const store = new MemAuditStore();
    await emit_audit(store, { type: 'x' }, { keyGen: () => 'a1b2c3d4e5f6' });
    expect(store.puts[0]?.key).toBe('op-a1b2c3d4e5f6');
  });

  it('入参 record 不被原地修改（落库为合并后的新对象）', async () => {
    const store = new MemAuditStore();
    const record = { type: 'cache_invalidation', note: 'x' };
    await emit_audit(store, record);
    expect(record).toEqual({ type: 'cache_invalidation', note: 'x' });
    const written = store.puts[0]?.data;
    expect(written).not.toBe(record);
    expect(written?.['note']).toBe('x');
    expect(written?.['ts']).toBe(0);
    expect(written?.['kind']).toBe('cache_invalidation');
  });
});

describe('emit_audit 豁免通道（受守卫存储）', () => {
  it('allow_mechanism(set_audit) 包裹 put，put 落在 enter/exit 之间', async () => {
    const store = new MemGuardedStore();
    await emit_audit(store, { type: 'edge_degrade', edge: 'e1' });
    expect(store.allowCalls).toEqual(['set_audit']);
    expect(store.events).toEqual(['enter', 'put:set_audit', 'exit']);
    expect(store.putCount).toBe(1);
    expect(store.depth).toBe(0);
  });

  it('裸存储缺 put_record（接口漂移）：静默跳过不抛', async () => {
    const broken = {} as unknown as AuditStorage;
    await expect(emit_audit(broken, { type: 'x' })).resolves.toBeUndefined();
  });

  it('put_record 抛错：跳过不抛，后续正常落库不受影响', async () => {
    const flaky = new MemAuditStore();
    flaky.put_record = async () => {
      throw new Error('disk full');
    };
    await expect(emit_audit(flaky, { type: 'x' })).resolves.toBeUndefined();
    const ok = new MemAuditStore();
    await emit_audit(ok, { type: 'x' });
    expect(ok.puts).toHaveLength(1);
  });

  it('豁免 enter/exit 抛错：一律不抛', async () => {
    const enterThrows = new MemGuardedStore();
    enterThrows.allow_mechanism = () => ({
      enter: async () => {
        throw new Error('enter failed');
      },
      exit: async () => {},
    });
    await expect(emit_audit(enterThrows, { type: 'x' })).resolves.toBeUndefined();

    const exitThrows = new MemGuardedStore();
    exitThrows.allow_mechanism = () => ({
      enter: async () => {},
      exit: async () => {
        throw new Error('exit failed');
      },
    });
    await expect(emit_audit(exitThrows, { type: 'x' })).resolves.toBeUndefined();
  });

  it('put 失败时仍走 exit（finally），且整体不抛', async () => {
    const store = new MemGuardedStore();
    store.put_record = async () => {
      throw new Error('guarded write failed');
    };
    await expect(emit_audit(store, { type: 'x' })).resolves.toBeUndefined();
    expect(store.events).toEqual(['enter', 'exit']);
    expect(store.depth).toBe(0);
  });
});

describe('emit_audit 无存储与无副作用', () => {
  it('storage 为 null/undefined：静默跳过、零写入、不抛', async () => {
    const store = new MemAuditStore();
    await expect(emit_audit(null, { type: 'x' })).resolves.toBeUndefined();
    await expect(emit_audit(undefined, { type: 'x' })).resolves.toBeUndefined();
    expect(store.puts).toHaveLength(0);
  });
});
