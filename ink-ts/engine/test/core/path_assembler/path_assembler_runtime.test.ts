/**
 * 路径组装器组装指令入口单测（test_path_assembler.py「组装指令入口」段移植，
 * canary=False 变体）。
 *
 * Python 原用例走 canary=True（单回合执行依赖 executor.Engine）；executor 未迁移
 * → 执行类用例 defer，本文件以 canary=False 变体验证装配层链路：模块级默认运行期
 * 未挂载零生效 / 开关关闭零生效 / 最近一次请求指纹记录（ENG9a-24）/ stats 运行期
 * 累计（ENG9a-8）。canary=True 的指令入口用例（含命中候选验证复用 ENG9a-7）随
 * executor 迁移后补测。
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

// ── defer 说明 ──────────────────────────────────────────────────────────
// 依赖引擎执行器（executor.Engine 未迁移）的指令入口用例按迁移批次 defer，
// 待 executor 模块落地后补测（Python 原用例默认 canary=True 走单回合执行）：
//   test_assemble_plan_runtime_canary_and_audit（canary=True 验证链路）
//   test_runtime_canary_options_propagate_to_execution（预算掐断 → canary 失败）
//   test_cache_hit_candidates_canary_verified_once（ENG9a-7 命中验证一次复用）
//   test_assemble_plan_envelope_reaches_draft_layer（ENG9a-3 envelope 透传）
//   test_runtime_assemble_plan_envelope_beam_and_draft（beam 宽度/草稿开关直通）
// 本文件的 stats 累计 / 指纹记录用例以 canary=False 重建级变体覆盖装配层链路。
