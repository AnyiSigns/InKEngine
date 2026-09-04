/**
 * 边证据存储语义单测（对标 ink_engine/tests/test_edge_evidence.py
 * 存储段）：成功/失败归集、avg_cost 滑动均值、跨域聚合隔离、契约版本
 * 入键失效、种子路径导入、存储行 → 评分全链路。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  derive_edge_tier,
  edge_score,
  laplace_success,
} from '../../../src/core/edge_evidence/tier_model.js';
import {
  EdgeKey,
  TIER_PROMOTED,
} from '../../../src/core/edge_evidence/_types.js';
import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import { import_seed_paths } from '../../../src/core/edge_evidence/seed.js';
import { makeEvidence, NOW } from './helpers.js';

describe('EdgeEvidenceStore', () => {
  let store: EdgeEvidenceStore;
  beforeEach(() => {
    store = new EdgeEvidenceStore();
  });

  it('record success/failure + get', async () => {
    const key: EdgeKey = makeEvidence(0, 0).key;
    expect(await store.get(key)).toBeNull();
    await store.record_success(key, { cost: 100, now: NOW });
    let ev = await store.get(key);
    expect(ev).not.toBeNull();
    expect(ev!.success_count).toBe(1);
    expect(ev!.fail_count).toBe(0);
    await store.record_failure(key, { cost: 200, now: NOW + 1 });
    ev = await store.get(key);
    expect(ev!.success_count).toBe(1);
    expect(ev!.fail_count).toBe(1);
    await store.close();
  });

  it('avg_cost sliding mean', async () => {
    const key: EdgeKey = makeEvidence(0, 0).key;
    await store.record_success(key, { cost: 100 });
    await store.record_success(key, { cost: 200 });
    let ev = await store.get(key);
    expect(ev!.avg_cost).toBeCloseTo(150);
    await store.record_success(key, {});
    ev = await store.get(key);
    expect(ev!.avg_cost).toBeCloseTo(150);
    await store.close();
  });

  it('delta-weighted avg_cost (batched vs sequential equivalent)', async () => {
    const key: EdgeKey = makeEvidence(0, 0).key;
    await store.record_success(key, { cost: 100, delta: 1 });
    await store.record_success(key, { cost: 200, delta: 3 });
    let ev = await store.get(key);
    expect(ev!.success_count).toBe(4);
    expect(ev!.avg_cost).toBeCloseTo(175);
    await store.record_success(key, { cost: 999, delta: 0 });
    ev = await store.get(key);
    expect(ev!.avg_cost).toBeCloseTo(175);
    await store.close();
  });

  it('cross-domain isolation', async () => {
    const code: EdgeKey = { ...makeEvidence(0, 0).key, context_domain: 'code' };
    const docs: EdgeKey = { ...makeEvidence(0, 0).key, context_domain: 'docs' };
    await store.record_success(code, { cost: 50 });
    await store.record_success(docs, { cost: 900 });
    const codeEv = await store.get(code);
    const docsEv = await store.get(docs);
    expect(codeEv!.success_count).toBe(1);
    expect(docsEv!.success_count).toBe(1);
    expect(codeEv!.avg_cost).toBeCloseTo(50);
    expect(docsEv!.avg_cost).toBeCloseTo(900);
    expect(await store.evidence_count()).toBe(2);
    expect(await store.evidence_count('code')).toBe(1);
    expect((await store.list_edges('code')).length).toBe(1);
    expect((await store.list_edges('docs')).length).toBe(1);
    await store.close();
  });

  it('contract version key eviction (bump version = cold start)', async () => {
    const old: EdgeKey = { ...makeEvidence(0, 0).key, src_contract_version: '1' };
    const next: EdgeKey = { ...makeEvidence(0, 0).key, src_contract_version: '2' };
    await store.record_success(old, {});
    expect(await store.get(old)).not.toBeNull();
    expect(await store.get(next)).toBeNull();
    await store.record_success(next, {});
    expect((await store.get(next))!.success_count).toBe(1);
    expect((await store.get(old))!.success_count).toBe(1);
    await store.close();
  });

  it('seed path import (existing not overwritten)', async () => {
    const seeds = [
      {
        src_type: 'a',
        dst_type: 'b',
        context_domain: 'code',
        success_count: 30,
        fail_count: 2,
      },
      {
        src_type: 'b',
        dst_type: 'c',
        context_domain: 'code',
        success_count: 10,
        fail_count: 0,
        policy: true,
      },
    ];
    const written = await import_seed_paths(store, seeds);
    expect(written).toBe(2);
    const seedKey: EdgeKey = { ...makeEvidence(0, 0).key };
    const seedEv = await store.get(seedKey);
    expect(seedEv!.success_count).toBe(30);
    const keyBC: EdgeKey = { ...makeEvidence(0, 0).key, src_type: 'b', dst_type: 'c' };
    await store.record_success(keyBC, {});
    const again = await import_seed_paths(store, seeds);
    expect(again).toBe(0);
    const ev = await store.get(keyBC);
    expect(ev!.success_count).toBe(11);
    expect(ev!.policy).toBe(true);
    await store.close();
  });

  it('store row -> scoring full chain', async () => {
    const key: EdgeKey = makeEvidence(0, 0).key;
    for (let i = 0; i < 28; i += 1) await store.record_success(key, {});
    for (let i = 0; i < 2; i += 1) await store.record_failure(key, {});
    const ev = await store.get(key);
    expect(derive_edge_tier(ev!.success_count, ev!.fail_count)).toBe(TIER_PROMOTED);
    const score = edge_score(ev!, { now: NOW });
    expect(score.tau).toBe(1.0);
    expect(score.p).toBeCloseTo(laplace_success(28, 2));
    await store.close();
  });
});