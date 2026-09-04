/**
 * 路径组装器缓存机制单测（test_path_assembler.py ENG9a 缓存段 1:1 移植）：
 * 同域证据单查（ENG9a-16）/ 结果统计按值拷贝隔离（ENG9a-19）/ ε 抽样随机源
 * 注入（ENG9a-20）/ 顶替判据两侧同基线（ENG9a-5）。纯组装器路径（不经指令
 * 入口/执行器），canary/executor 不参与。
 */

import { describe, expect, it } from 'vitest';

import { PathAssemblyConfig } from '../../../src/core/contracts/contracts.js';
import { EdgeEvidenceStore, edge_evidence_to_dict } from '../../../src/core/edge_evidence/index.js';
import type { EdgeEvidence, EdgeKey } from '../../../src/core/edge_evidence/index.js';
import { FingerprintCacheStore } from '../../../src/core/fingerprint_cache/index.js';
import { request_fingerprint } from '../../../src/core/fingerprint/fingerprint.js';
import { graph_fingerprint } from '../../../src/core/fingerprint/fingerprint.js';
import {
  STATS_CACHE_HITS,
  STATS_CACHE_MISSES,
  STATS_CACHE_REPLACEMENTS,
} from '../../../src/core/path_assembler/index.js';
import { PathAssembler } from '../../../src/core/path_assembler/index.js';
import { DUMMY_NOW, make_registry, make_request } from './helpers.js';

function edge_key(src_type: string, dst_type: string): EdgeKey {
  return {
    src_type,
    dst_type,
    src_contract_version: '1',
    dst_contract_version: '1',
    context_domain: 'code',
    variant_hash: '',
  };
}

function request_cache_key(request: ReturnType<typeof make_request>): string {
  return request_fingerprint({
    goal_fields: request.goal_fields(),
    entry_fields: request.entry_fields,
    domain: request.domain,
    max_safety_tier: request.max_safety_tier,
    model_id: '',
  });
}

/** 计数 EdgeEvidenceStore（list_edges 调用断言用）。 */
class SpyStore extends EdgeEvidenceStore {
  calls: string[] = [];

  async list_edges(domain: string | null = null): Promise<EdgeEvidence[]> {
    this.calls.push(domain ?? '');
    return super.list_edges(domain);
  }
}

describe('缓存证据单查与统计隔离', () => {
  it('test_evidence_queried_once_per_domain：同域全量 list_edges 只查一次（ENG9a-16）', async () => {
    const registry = make_registry();
    const cache = new FingerprintCacheStore({ now: DUMMY_NOW });
    const spy = new SpyStore();
    const assembler = new PathAssembler({
      registry,
      evidence_store: spy,
      cache,
      config: new PathAssemblyConfig({ enabled: true }),
      cache_epsilon: 0.0,
      now: DUMMY_NOW,
    });
    await assembler.assemble(make_request(['answer']));
    expect(spy.calls.length).toBe(1);
    await spy.close();
    await cache.close();
  });

  it('test_stats_isolated_from_shared_dict：结果统计按值拷贝（ENG9a-19）', async () => {
    const assembler = new PathAssembler({
      registry: make_registry(),
      now: DUMMY_NOW,
    });
    const result = await assembler.assemble(make_request(['answer']));
    result.stats['beam_extensions'] = 999999;
    const again = await assembler.assemble(make_request(['answer']));
    expect(again.stats['beam_extensions']!).toBeLessThan(999999);
  });
});

describe('ε 抽样重装 / 顶替判据', () => {
  it('test_epsilon_sampling_rng_injectable：seed 固定 → 抽样判定可复现（ENG9a-20）', async () => {
    const registry = make_registry();
    const store = new EdgeEvidenceStore();
    const cache = new FingerprintCacheStore({ now: DUMMY_NOW });
    const request = make_request(['answer']);
    const first = await new PathAssembler({
      registry,
      evidence_store: store,
      cache,
      config: new PathAssemblyConfig({ enabled: true }),
      now: DUMMY_NOW,
    }).assemble(request);
    expect(first.candidates.length).toBeGreaterThan(0);
    await cache.upsert(request_cache_key(request), {
      path: first.candidates[0]!.graph.to_dict(),
      evidence_snapshot: [],
      model_id: '',
      gate_passed: true,
      path_fingerprint: graph_fingerprint(first.candidates[0]!.graph),
      domain: request.domain,
    });
    const build = () =>
      new PathAssembler({
        registry,
        evidence_store: store,
        cache,
        config: new PathAssemblyConfig({ enabled: true }),
        cache_epsilon: 1.0,
        rng: () => 0.5,
        now: DUMMY_NOW,
      });
    const a1 = await build().assemble(request);
    const a2 = await build().assemble(request);
    // ε=1.0 恒抽样重装：绕过缓存（miss=1 且 hits=0）——rng 注入路径生效
    expect(a1.stats[STATS_CACHE_MISSES]).toBe(1);
    expect(a2.stats[STATS_CACHE_MISSES]).toBe(1);
    expect(a1.stats[STATS_CACHE_HITS]).toBe(0);
    await store.close();
    await cache.close();
  });

  it('test_replace_baseline_uses_current_evidence：顶替判据两侧同基线（ENG9a-5）', async () => {
    const small_pool = [
      ['A', [], ['x']],
      ['B', ['x'], ['goal']],
      ['C', ['x'], ['goal']],
    ] as const;
    const registry = make_registry(small_pool as never);
    const evidence = new EdgeEvidenceStore();
    const cache = new FingerprintCacheStore({ now: DUMMY_NOW });
    const assembler = new PathAssembler({
      registry,
      evidence_store: evidence,
      cache,
      config: new PathAssemblyConfig({ enabled: true }),
      cache_epsilon: 0.0,
      now: DUMMY_NOW,
    });
    const request = make_request(['goal']);
    const first = await assembler.assemble(request);
    expect(first.candidates[0]!.chain).toEqual(['A', 'B']);
    const key = request_cache_key(request);
    const b_edge = edge_key('A', 'B');
    const c_edge = edge_key('A', 'C');
    for (let i = 0; i < 30; i++) {
      await evidence.record_success(b_edge, { now: DUMMY_NOW });
    }
    await cache.upsert(key, {
      path: first.candidates[0]!.graph.to_dict(),
      evidence_snapshot: (await evidence.list_edges('code')).map((e) => edge_evidence_to_dict(e)),
      model_id: '',
      gate_passed: true,
      path_fingerprint: first.candidates[0]!.graph.digest(),
      domain: 'code',
    });
    // 证据漂移：B 边灌失败（当前分大跌），C 边灌中量成功
    for (let i = 0; i < 30; i++) {
      await evidence.record_failure(b_edge, { now: DUMMY_NOW });
    }
    for (let i = 0; i < 25; i++) {
      await evidence.record_success(c_edge, { now: DUMMY_NOW });
    }
    const second = await assembler.assemble(request);
    expect(second.stats[STATS_CACHE_REPLACEMENTS]).toBe(1);
    expect(second.candidates[0]!.chain).toEqual(['A', 'C']);
    await evidence.close();
    await cache.close();
  });
});

// ── defer 说明 ──────────────────────────────────────────────────────────
// 本文件为纯组装器缓存机制路径（不经指令入口/执行器），无 defer 项；
// 命中候选 canary 验证复用（ENG9a-7）依赖 executor 单回合执行，已 defer
// （见 unit/runtime 测试文件尾注）。
