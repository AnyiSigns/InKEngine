/**
 * 指纹缓存存储语义单测（对标 test_fingerprint_cache.py 存储段）：
 * 存储往返与计数、入缓存质量线 fail-closed、命中失败强失效、容量上限
 * 淘汰序（命中率 → 时效 → 键序、按域分组）、语义化失效（单条/按域/全库
 * + 审计留痕）。存储用默认内存 seam（注入 now 固定时间戳，确定性）。
 *
 * 暂缓用例（需执行器/组装器集成，见 mechanism.test.ts 头注）：组装命中
 * 不触发搜索、跳过草稿、沉淀钩子键一致、三失效信号全链路（执行失败/
 * canary/证据漂移顶替/ε 抽样）、契约版本与模型 id 钉死集成、flag 零参与、
 * 无闸门不入缓存。
 */

import { describe, expect, it } from 'vitest';

import {
  type AuditRecord,
  type AuditStorage,
} from '../../../src/core/audit_log/audit_log.js';
import { EVENT_AUDIT_FINGERPRINT_REPLACE } from '../../../src/core/event_types/eventTypeSpecs.js';
import { FingerprintCacheStore, invalidate_cache } from '../../../src/core/fingerprint_cache/index.js';

const NOW = 1_800_000_000;

/** 审计内存假存储：记录全部 put 调用（invalidate_cache 审计断言用）。 */
class MemAuditStore implements AuditStorage {
  puts: Array<{ collection: string; key: string; data: AuditRecord }> = [];

  async put_record(collection: string, key: string, data: AuditRecord): Promise<void> {
    this.puts.push({ collection, key, data });
  }
}

const EMPTY_ROW: Record<string, unknown> = { nodes: {} };

function makeStore(cap?: number): FingerprintCacheStore {
  return new FingerprintCacheStore({ now: NOW, cap_per_domain: cap });
}

describe('存储往返与计数', () => {
  it('upsert/lookup 往返 + 命中数/失败数/域字段/快照随条目落', async () => {
    const store = makeStore();
    const path = { nodes: { a: { type: 'a', contract: { version: 2 } } } };
    const snap: Array<Record<string, unknown>> = [
      { src_type: 'a', dst_type: 'b', success_count: 5, fail_count: 1 },
    ];
    expect(
      await store.upsert('fp-1', {
        path,
        evidence_snapshot: snap,
        model_id: 'm1',
        gate_passed: true,
        path_fingerprint: 'dig-1',
        domain: 'code',
      }),
    ).toBe(true);
    const entry = await store.lookup('fp-1');
    expect(entry).not.toBeNull();
    expect(entry!.context_fingerprint).toBe('fp-1');
    expect(entry!.path).toEqual(path);
    expect(entry!.path_fingerprint).toBe('dig-1');
    expect(entry!.evidence_snapshot).toEqual(snap);
    expect(entry!.contract_snapshot).toEqual([['a', '2']]); // 契约版本快照随条目落
    expect(entry!.model_id).toBe('m1');
    expect(entry!.domain).toBe('code');
    expect(entry!.created_at).toBe(NOW);
    expect(entry!.updated_at).toBe(NOW);
    expect(entry!.hit_count).toBe(0);
    expect(entry!.fail_count).toBe(0);
    // 命中成功执行 → 命中数+1 并刷新时间戳
    expect(await store.report('fp-1', { ok: true })).toBe(true);
    expect((await store.get('fp-1'))!.hit_count).toBe(1);
    // 域字段独立记录（键含域语义；不同域不同键互不干扰）
    expect(
      await store.upsert('fp-docs', {
        path,
        evidence_snapshot: [],
        model_id: 'm1',
        gate_passed: true,
        path_fingerprint: 'dig-2',
        domain: 'docs',
      }),
    ).toBe(true);
    expect(await store.count('code')).toBe(1);
    expect(await store.count('docs')).toBe(1);
    expect(await store.count()).toBe(2);
    await store.close();
  });

  it('入缓存质量线：gate_passed=False 不落库（缓存体只收合格条目）', async () => {
    const store = makeStore();
    expect(
      await store.upsert('fp-x', {
        path: EMPTY_ROW,
        evidence_snapshot: [],
        model_id: '',
        gate_passed: false,
        domain: 'code',
      }),
    ).toBe(false);
    expect(await store.count()).toBe(0);
    expect(await store.lookup('fp-x')).toBeNull();
    expect(store.stats.upserts).toBe(0);
    await store.close();
  });

  it('命中失败 → 失败数+1 且条目立即失效（不命中）；计数保留可观测', async () => {
    const store = makeStore();
    await store.upsert('fp-f', {
      path: EMPTY_ROW,
      evidence_snapshot: [],
      model_id: '',
      gate_passed: true,
      path_fingerprint: 'd',
      domain: 'code',
    });
    expect(await store.report('fp-f', { ok: false })).toBe(true);
    const entry = await store.get('fp-f');
    expect(entry).not.toBeNull();
    expect(entry!.fail_count).toBe(1);
    expect(entry!.invalid).toBe(true);
    expect(await store.lookup('fp-f')).toBeNull(); // 失效条目不命中
    expect(await store.report('fp-f', { ok: false })).toBe(false); // 已失效不再计数
    await store.close();
  });

  it('close() 后任何读写抛 StorageError（Python _connect 同语义）', async () => {
    const store = makeStore();
    await store.close();
    await expect(store.lookup('fp-1')).rejects.toThrow('存储已关闭');
    await expect(
      store.upsert('fp-1', {
        path: EMPTY_ROW,
        evidence_snapshot: [],
        model_id: '',
        gate_passed: true,
      }),
    ).rejects.toThrow('存储已关闭');
  });
});

describe('容量上限 + 淘汰（命中率 + 时效）', () => {
  it('达上限按「命中率 → 时效 → 键序」淘汰最差条目（确定性）', async () => {
    const store = makeStore(3);
    for (let i = 0; i < 4; i += 1) {
      await store.upsert(`fp-${i}`, {
        path: EMPTY_ROW,
        evidence_snapshot: [],
        model_id: '',
        gate_passed: true,
        path_fingerprint: `d${i}`,
        domain: 'code',
      });
    }
    expect(await store.count('code')).toBe(3);
    // 全零命中：最先写入（最旧）被淘汰
    expect(await store.get('fp-0')).toBeNull();
    expect(await store.get('fp-1')).not.toBeNull();
    expect(store.stats.evictions).toBe(1);
    await store.close();
  });

  it('命中率优先于时效：高命中条目即使更旧也保留', async () => {
    const store = makeStore(3);
    for (let i = 0; i < 3; i += 1) {
      await store.upsert(`fp-${i}`, {
        path: EMPTY_ROW,
        evidence_snapshot: [],
        model_id: '',
        gate_passed: true,
        path_fingerprint: `d${i}`,
        domain: 'code',
      });
    }
    await store.report('fp-0', { ok: true }); // 命中率 1.0（唯一有命中者）
    await store.report('fp-0', { ok: true });
    await store.upsert('fp-new', {
      path: EMPTY_ROW,
      evidence_snapshot: [],
      model_id: '',
      gate_passed: true,
      path_fingerprint: 'dn',
      domain: 'code',
    });
    // fp-0 命中率高保留；fp-1/fp-2 零命中淘汰其一（键序确定性）
    expect(await store.get('fp-0')).not.toBeNull();
    expect(await store.get('fp-1')).toBeNull();
    expect(await store.get('fp-2')).not.toBeNull();
    expect(await store.get('fp-new')).not.toBeNull();
    await store.close();
  });

  it('容量按域分组：达上限只淘汰本域条目，他域不受影响', async () => {
    const store = makeStore(2);
    for (let i = 0; i < 3; i += 1) {
      await store.upsert(`fp-${i}`, {
        path: EMPTY_ROW,
        evidence_snapshot: [],
        model_id: '',
        gate_passed: true,
        path_fingerprint: `d${i}`,
        domain: 'code',
      });
    }
    await store.upsert('fp-docs', {
      path: EMPTY_ROW,
      evidence_snapshot: [],
      model_id: '',
      gate_passed: true,
      path_fingerprint: 'dd',
      domain: 'docs',
    });
    expect(await store.count('code')).toBe(2);
    expect(await store.count('docs')).toBe(1);
    await store.close();
  });
});

describe('invalidate_cache 语义化失效', () => {
  it('单条指纹失效：计数保留、审计 domain 从条目反查、reason 缺省人工失效', async () => {
    const store = makeStore();
    const audit = new MemAuditStore();
    await store.upsert('fp-1', {
      path: EMPTY_ROW,
      evidence_snapshot: [],
      model_id: '',
      gate_passed: true,
      path_fingerprint: 'd1',
      domain: 'code',
    });
    const result = await invalidate_cache(store, 'fp-1', { storage: audit, now: NOW });
    expect(result).toEqual({ invalidated: 1, scope: 'fp-1' });
    expect(await store.lookup('fp-1')).toBeNull(); // 降级不命中
    expect(await store.get('fp-1')).not.toBeNull(); // 计数保留
    expect(audit.puts).toHaveLength(1);
    const data = audit.puts[0]!.data;
    expect(data.type).toBe(EVENT_AUDIT_FINGERPRINT_REPLACE);
    expect(data.domain).toBe('code');
    expect(data.fingerprint).toBe('fp-1');
    expect(data.reason).toBe('人工失效');
    expect(data.invalidated).toBe(1);
    expect(data.ts).toBe(NOW);
    await store.close();
  });

  it('未知指纹 = 0 条失效（fail-closed 不报错），审计 domain 为空', async () => {
    const store = makeStore();
    const audit = new MemAuditStore();
    const result = await invalidate_cache(store, 'no-such', { storage: audit });
    expect(result).toEqual({ invalidated: 0, scope: 'no-such' });
    expect(audit.puts[0]!.data.domain).toBe('');
    expect(audit.puts[0]!.data.invalidated).toBe(0);
    await store.close();
  });

  it('domain:<域> 只失效该域全部条目', async () => {
    const store = makeStore();
    const audit = new MemAuditStore();
    for (const [fp, domain] of [
      ['a-x', 'code'],
      ['d-x', 'docs'],
      ['d-y', 'docs'],
    ] as const) {
      await store.upsert(fp, {
        path: EMPTY_ROW,
        evidence_snapshot: [],
        model_id: '',
        gate_passed: true,
        domain,
      });
    }
    const result = await invalidate_cache(store, 'domain:docs', { storage: audit });
    expect(result.invalidated).toBe(2);
    expect((await store.get('d-x'))!.invalid).toBe(true);
    expect((await store.get('d-y'))!.invalid).toBe(true);
    expect((await store.get('a-x'))!.invalid).toBe(false);
    expect(audit.puts[0]!.data.domain).toBe('docs');
    expect(audit.puts[0]!.data.invalidated).toBe(2);
    await store.close();
  });

  it('"*" 整库失效：逐项失效计数累加、审计 domain 为空串、fingerprint 为空', async () => {
    const store = makeStore();
    const audit = new MemAuditStore();
    await store.upsert('fp-1', {
      path: EMPTY_ROW,
      evidence_snapshot: [],
      model_id: '',
      gate_passed: true,
      domain: 'code',
    });
    await store.upsert('fp-2', {
      path: EMPTY_ROW,
      evidence_snapshot: [],
      model_id: '',
      gate_passed: true,
      domain: 'docs',
    });
    const result = await invalidate_cache(store, '*', { storage: audit });
    expect(result).toEqual({ invalidated: 2, scope: '*' });
    expect(await store.count()).toBe(2); // 条目保留，仅失效
    const data = audit.puts[0]!.data;
    expect(data.domain).toBe('');
    expect(data.fingerprint).toBe('');
    expect(data.invalidated).toBe(2);
    await store.close();
  });

  it('空 scope = fail-closed 拒绝（不静默吞错）', async () => {
    const store = makeStore();
    await expect(invalidate_cache(store, '')).rejects.toThrow('scope 不能为空');
    await store.close();
  });
});