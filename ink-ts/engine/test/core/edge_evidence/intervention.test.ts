/**
 * 干预能力单测（对标 ink_engine/tests/test_edge_evidence.py 干预段）：
 * 信任档降级 + 反向复原（落受控通道 + 审计）。executor 侧接线单测
 * （settle 归因、并发 upsert 原子性等）依赖宿主 IO seam，本目录暂略。
 */

import { describe, expect, it } from 'vitest';

import {
  EdgeKey,
  TIER_PROMOTED,
  TIER_REGULAR,
} from '../../../src/core/edge_evidence/_types.js';
import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import {
  downgrade_edge_tier,
  restore_edge_tier,
} from '../../../src/core/edge_evidence/intervention.js';
import type { AuditRecord } from '../../../src/core/audit_log/audit_log.js';
import { makeEvidence } from './helpers.js';

interface FakeStorage {
  records: Map<string, Map<string, Record<string, unknown>>>;
  puts: Array<{ collection: string; key: string; data: Record<string, unknown> }>;
}

function fakeEvolutionStorage(fs: FakeStorage) {
  return {
    async get_record(collection: string, key: string) {
      const m = fs.records.get(collection);
      if (m === undefined) return null;
      const v = m.get(key);
      return v === undefined ? null : { ...v };
    },
    async put_record(collection: string, key: string, data: Record<string, unknown>) {
      fs.puts.push({ collection, key, data });
      let m = fs.records.get(collection);
      if (m === undefined) {
        m = new Map();
        fs.records.set(collection, m);
      }
      m.set(key, { ...data });
    },
  };
}

describe('Trust-tier manual downgrade + restore', () => {
  it('downgrade to promoted keeps derived tier = promoted', async () => {
    const store = new EdgeEvidenceStore();
    const fs: FakeStorage = { records: new Map(), puts: [] };
    const storage = fakeEvolutionStorage(fs);
    const key: EdgeKey = { ...makeEvidence(0, 0).key, context_domain: 'default' };
    await store.put({
      ...makeEvidence(0, 0, { domain: 'default' }),
      success_count: 35,
      fail_count: 3,
      avg_cost: 1.5,
    });
    const res = await downgrade_edge_tier(store, key, {
      target_tier: TIER_PROMOTED,
      storage: storage as never,
    });
    expect(res.from_tier).toBe(TIER_PROMOTED);
    expect(res.to_tier).toBe(TIER_PROMOTED);
    const after = await store.get(key);
    expect(after!.avg_cost).toBeCloseTo(1.5);
    expect(fs.puts.some((p) => p.collection === 'edge_tier_overrides')).toBe(true);
    await store.close();
  });

  it('unknown target / missing edge is rejected', async () => {
    const store = new EdgeEvidenceStore();
    const key: EdgeKey = makeEvidence(0, 0).key;
    let threwUnknown = false;
    try {
      await downgrade_edge_tier(store, key, { target_tier: 'unknown' });
    } catch (e) {
      threwUnknown = true;
      expect(String(e).length).toBeGreaterThan(0);
    }
    expect(threwUnknown).toBe(true);
    const missing: EdgeKey = { ...makeEvidence(0, 0).key, src_type: 'x' };
    let threwMissing = false;
    try {
      await downgrade_edge_tier(store, missing, { target_tier: TIER_REGULAR });
    } catch (e) {
      threwMissing = true;
      expect(String(e).length).toBeGreaterThan(0);
    }
    expect(threwMissing).toBe(true);
    await store.close();
  });

  it('restore from override snapshot', async () => {
    const store = new EdgeEvidenceStore();
    const fs: FakeStorage = { records: new Map(), puts: [] };
    const storage = fakeEvolutionStorage(fs);
    const key: EdgeKey = { ...makeEvidence(0, 0).key, context_domain: 'default' };
    await store.put({
      ...makeEvidence(0, 0, { domain: 'default' }),
      success_count: 35,
      fail_count: 3,
      avg_cost: 1.5,
    });
    await downgrade_edge_tier(store, key, {
      target_tier: TIER_REGULAR,
      storage: storage as never,
    });
    const restored = await restore_edge_tier(store, key, { storage: storage as never });
    expect(restored).not.toBeNull();
    expect(restored!.restored).toBe(true);
    await store.close();
  });

  it('no snapshot / storage=undefined returns null', async () => {
    const store = new EdgeEvidenceStore();
    const key: EdgeKey = makeEvidence(0, 0).key;
    expect(await restore_edge_tier(store, key, { storage: undefined })).toBeNull();
    const fs: FakeStorage = { records: new Map(), puts: [] };
    const storage = fakeEvolutionStorage(fs);
    expect(await restore_edge_tier(store, key, { storage: storage as never })).toBeNull();
    await store.close();
  });

  it('downgrade emits audit record (type=policy_edge_review_audit)', async () => {
    const fs: FakeStorage = { records: new Map(), puts: [] };
    const auditPuts: Array<{ collection: string; key: string; data: AuditRecord }> = [];
    const storage = {
      async get_record(c: string, k: string) {
        const m = fs.records.get(c);
        return m === undefined ? null : (m.get(k) ?? null);
      },
      async put_record(c: string, k: string, d: AuditRecord) {
        auditPuts.push({ collection: c, key: k, data: d });
        let m = fs.records.get(c);
        if (m === undefined) {
          m = new Map();
          fs.records.set(c, m);
        }
        m.set(k, { ...d });
      },
    };
    const store = new EdgeEvidenceStore();
    const key: EdgeKey = { ...makeEvidence(0, 0).key, context_domain: 'default' };
    await store.put({
      ...makeEvidence(0, 0, { domain: 'default' }),
      success_count: 35,
      fail_count: 3,
    });
    await downgrade_edge_tier(store, key, {
      target_tier: TIER_REGULAR,
      storage: storage as never,
    });
    const audit = auditPuts.find(
      (p) => p.collection === 'set_audit' && p.data['type'] === 'policy_edge_review_audit',
    );
    expect(audit).toBeDefined();
    await store.close();
  });
});