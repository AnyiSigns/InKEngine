/**
 * 路径组装器组装指令入口单测（test_path_assembler.py「组装指令入口」段移植，
 * canary=False 变体 + canary=True 全链用例）。
 *
 * canary 默认关闭（重建级校验交付，不替宿主跑成本敏感的单回合）；canary=True
 * 的指令入口用例（单候选单回合执行 + 审计、命中候选验证复用）见
 * path_assembler_canary.test.ts。本文件以 canary=False 变体验证装配层链路：
 * 模块级默认运行期未挂载零生效 / 开关关闭零生效 / 最近一次请求指纹记录
 * （ENG9a-24）/ stats 运行期累计（ENG9a-8）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { PathAssemblyConfig } from '../../../src/core/contracts/contracts.js';
import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/index.js';
import { FingerprintCacheStore } from '../../../src/core/fingerprint_cache/index.js';
import { request_fingerprint } from '../../../src/core/fingerprint/fingerprint.js';
import {
  PathAssemblyRuntime,
  assemble_plan,
  get_default_assembly_runtime,
  set_default_assembly_runtime,
} from '../../../src/core/path_assembler/index.js';
import { DUMMY_NOW, make_registry, make_request } from './helpers.js';

describe('模块级默认运行期 / 指令入口', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('test_assemble_plan_unwired_default_zero_effect：未挂载 = 空结果零审计', async () => {
    set_default_assembly_runtime(null);
    const records: Record<string, unknown>[] = [];
    const result = await assemble_plan(make_request(['answer']), {
      audit_sink: (r) => records.push(r),
    });
    expect(result.is_empty).toBe(true);
    expect(result.audit).toEqual([]);
    expect(records).toEqual([]);
  });

  it('test_assemble_plan_runtime_disabled_zero_effect：开关关闭零候选零审计', async () => {
    const runtime = new PathAssemblyRuntime({
      registry: make_registry(),
      config: new PathAssemblyConfig(), // enabled=False
      canary: false,
      now: DUMMY_NOW,
    });
    set_default_assembly_runtime(runtime);
    const records: Record<string, unknown>[] = [];
    const result = await assemble_plan(make_request(['answer']), {
      audit_sink: (r) => records.push(r),
    });
    expect(result.is_empty).toBe(true);
    expect(result.canary).toEqual([]);
    expect(records).toEqual([]);
  });

  it('test_runtime_assemble_plan_produces_result_and_audit：canary=False 组装+审计留痕', async () => {
    const runtime = new PathAssemblyRuntime({
      registry: make_registry(),
      config: new PathAssemblyConfig({ enabled: true }),
      canary: false,
      now: DUMMY_NOW,
    });
    const records: Record<string, unknown>[] = [];
    const result = await runtime.assemble_plan(make_request(['answer']), {
      audit_sink: (r) => records.push(r),
    });
    expect(result.is_empty).toBe(false);
    expect(result.canary.length).toBe(result.candidates.length);
    for (const verdict of result.canary) {
      expect(verdict.ok).toBe(true);
      expect(verdict.executed).toBe(false); // canary=False 仅重建级校验
    }
    expect(records.length).toBe(1 + result.candidates.length);
    expect(records[0]!['domain']).toBe('code');
    expect(records[0]!['fingerprint']).toBe(result.fingerprint);
  });
});

describe('运行期统计累计 / 最近请求指纹（canary=False 变体）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('test_runtime_stats_total_accumulates：组装统计跨调用累计（ENG9a-8）', async () => {
    const registry = make_registry();
    const evidence = new EdgeEvidenceStore();
    const cache = new FingerprintCacheStore({ now: DUMMY_NOW });
    const runtime = new PathAssemblyRuntime({
      registry,
      evidence_store: evidence,
      config: new PathAssemblyConfig({ enabled: true }),
      cache,
      cache_epsilon: 0.0,
      canary: false,
      now: DUMMY_NOW,
    });
    set_default_assembly_runtime(runtime);
    try {
      const req = make_request(['answer']);
      const first = await assemble_plan(req, { audit_sink: () => undefined });
      expect(runtime.stats_total['cache_misses']).toBe(1);
      expect(runtime.stats_total['beam_extensions']).toBe(first.stats['beam_extensions']);
      // 沉淀侧写入缓存（FingerprintSettleHook 同源形态）后再调：命中累计
      const graph = first.candidates[0]!.graph;
      const key = request_fingerprint({
        goal_fields: req.goal_fields(),
        entry_fields: req.entry_fields,
        domain: req.domain,
        max_safety_tier: req.max_safety_tier,
        model_id: '',
      });
      await cache.upsert(key, {
        path: graph.to_dict(),
        evidence_snapshot: [],
        model_id: '',
        gate_passed: true,
        path_fingerprint: graph.digest(),
        domain: 'code',
      });
      await assemble_plan(make_request(['answer']), { audit_sink: () => undefined });
      expect(runtime.stats_total['cache_hits']).toBe(1);
      expect(runtime.stats_total['cache_misses']).toBe(1); // 命中不再累计 miss
      await assemble_plan(make_request(['answer']), { audit_sink: () => undefined });
      expect(runtime.stats_total['cache_hits']).toBe(2);
    } finally {
      await evidence.close();
      await cache.close();
    }
  });

  it('test_runtime_records_last_request_fingerprint：最近一次请求指纹记录（写入键同空间）', async () => {
    const registry = make_registry();
    const cache = new FingerprintCacheStore({ now: DUMMY_NOW });
    const runtime = new PathAssemblyRuntime({
      registry,
      config: new PathAssemblyConfig({ enabled: true }),
      cache,
      cache_epsilon: 0.0,
      canary: false,
      now: DUMMY_NOW,
    });
    set_default_assembly_runtime(runtime);
    try {
      const req = make_request(['answer']);
      expect(runtime.last_request_fingerprint).toBe('');
      await assemble_plan(req, { audit_sink: () => undefined });
      const expected = request_fingerprint({
        goal_fields: req.goal_fields(),
        entry_fields: req.entry_fields,
        domain: req.domain,
        max_safety_tier: req.max_safety_tier,
        model_id: '',
      });
      expect(runtime.last_request_fingerprint).toBe(expected);
      expect(runtime.last_request_fingerprint).toBe(runtime._request_cache_key(req));
    } finally {
      await cache.close();
    }
  });
});

// ── 覆盖说明 ──────────────────────────────────────────────────────────
// canary=True 的指令入口用例（test_assemble_plan_runtime_canary_and_audit
// /test_runtime_canary_options_propagate_to_execution/ENG9a-7 命中验证一次
// 复用）已回补于 path_assembler_canary.test.ts（单回合真实执行 + canary 态 +
// 步数/超时护栏）。本文件的 stats 累计 / 指纹记录用例以 canary=False 重建级
// 变体覆盖装配层链路。
