/**
 * 路径组装器单元测（test_path_assembler.py 单元段 1:1 移植）：
 * goal 字段推导 / 空目标 / schema 反推多源汇聚 / 确定性排序 / 安全档剪枝 /
 * 统计口径 / 冷启动探索 / beam 排序目标相关度优先 / 多径判据复用 edge_evidence
 * / 冷启动指数带证据 / 草稿解析形态。
 *
 * 引擎执行器接线类用例（executor 未迁移）已 defer（见本文尾注），本文件只跑
 * 组装纯算法/证据层可复现路径。
 */

import { describe, expect, it } from 'vitest';

import { PathAssemblyConfig } from '../../../src/core/contracts/contracts.js';
import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/index.js';
import type { EdgeKey } from '../../../src/core/edge_evidence/index.js';
import { AssemblyRequest, InMemoryPoolRetriever, validate_chain } from '../../../src/core/path_assembler/index.js';
import {
  DUMMY_NOW,
  ENTRY,
  POOL_SPECS,
  contract,
  field,
  make_assembler,
  make_registry,
  make_request,
  pool_of,
  spec,
  type PoolSpec,
} from './helpers.js';

/** EdgeKey 便捷构造（契约版本缺省 '1'，域 code，变体空）。 */
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

describe('goal 字段 / 空目标', () => {
  it('test_goal_fields_prefer_required_then_declared：必填优先；无必填 = 全部声明；空 = 无', () => {
    const required_only = new AssemblyRequest({
      goal_schema: spec('g', field('a', true), field('b')),
    });
    expect(required_only.goal_fields()).toEqual(['a']);
    const all_declared = new AssemblyRequest({
      goal_schema: spec('g', field('a'), field('b')),
    });
    expect(all_declared.goal_fields()).toEqual(['a', 'b']);
    expect(new AssemblyRequest().goal_fields()).toEqual([]);
  });
});

describe('schema 反推与组装', () => {
  it('test_algorithm_solves_goal_with_multi_source_convergence：qa_check 多源汇聚合法', async () => {
    const result = await make_assembler().assemble(
      make_request(['code', 'tests', 'quality_report']),
    );
    expect(result.is_empty).toBe(false);
    const top = result.candidates[0]!;
    expect(top.chain).toContain('qa_check');
    expect(top.chain).toContain('code_gen');
    expect(top.chain).toContain('test_gen');
    const [ok, reasons] = validate_chain(top.chain, {
      pool: pool_of(make_registry()),
      goal_fields: ['code', 'tests', 'quality_report'],
      entry_fields: ENTRY,
    });
    expect(ok).toBe(true);
    expect(reasons).toEqual([]);
  });

  it('test_candidates_ranked_deterministically：同输入两次组装同序；零证据偏短链', async () => {
    const result_a = await make_assembler().assemble(make_request(['answer']));
    const result_b = await make_assembler().assemble(make_request(['answer']));
    expect(result_a.candidates.map((c) => c.chain)).toEqual(
      result_b.candidates.map((c) => c.chain),
    );
    expect(result_a.candidates[0]!.chain[result_a.candidates[0]!.chain.length - 1]).toBe(
      'answer_direct',
    );
  });

  it('test_safety_tier_clips_high_tier_nodes：安全档剪枝 + 放行抬档可入链', async () => {
    const registry = make_registry(POOL_SPECS, { safety_tier: { answer_direct: 0, report_assemble: 2 } });
    const strict = await make_assembler(registry).assemble(
      make_request(['answer'], { tier: 0, top_k: 3 }),
    );
    const loose = await make_assembler(registry).assemble(
      make_request(['answer'], { tier: 2, top_k: 20 }),
    );
    for (const candidate of strict.candidates) {
      expect(candidate.chain).not.toContain('report_assemble');
    }
    expect(strict.candidates[0]!.chain).toContain('answer_direct');
    expect(loose.candidates.some((c) => c.chain.includes('report_assemble'))).toBe(true);
    const [ok] = validate_chain(strict.candidates[0]!.chain, {
      pool: pool_of(registry),
      goal_fields: ['answer'],
      entry_fields: ENTRY,
      max_safety_tier: 0,
    });
    expect(ok).toBe(true);
  });

  it('test_stats_reported：beam 扩展/评分计算量/修复/草稿调用随结果携带', async () => {
    const result = await make_assembler().assemble(make_request(['answer']));
    expect(result.stats['beam_extensions']).toBeGreaterThan(0);
    expect(result.stats['edge_score_calls']).toBeGreaterThan(0);
    expect(result.stats['repair_attempts']).toBe(0);
    expect(result.stats['llm_attempts']).toBe(0);
  });

  it('test_cold_start_triggers_exploration：零证据 = 指数 0 → 探索模式', async () => {
    const result = await make_assembler().assemble(make_request(['answer']));
    expect(result.cold_start_index).toBe(0.0);
    expect(result.exploration_mode).toBe(true);
  });
});

describe('beam 排序目标相关度优先（实验定稿）', () => {
  it('test_beam_order_goal_relevance_first：字段多但零目标相关的分支被挤出 beam', async () => {
    const { _forward_search } = await import('../../../src/core/path_assembler/search.js');
    const tiny_pool = {
      rich: contract([], ['x', 'y']),
      goal_provider: contract([], ['dz']),
      plain: contract([], ['a_out']),
    };
    const found = _forward_search(['dz'], [], tiny_pool, { beam_width: 1, max_depth: 4 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toEqual(['goal_provider']);
    expect(found.some((chain) => chain[0] === 'goal_provider')).toBe(true);
    expect(found.some((chain) => chain[0] === 'rich' || chain[0] === 'plain')).toBe(false);
  });

  it('test_beam_keeps_parallel_branch_competitor_search：market_report 目标下 competitor 链不被挤出', async () => {
    const v3_like: readonly PoolSpec[] = [
      ['intent_parse', ['user_query'], ['intent', 'domains']],
      ['task_planner', ['intent'], ['spec', 'query']],
      ['frontend_gen', ['spec'], ['frontend_code']],
      ['backend_gen', ['spec'], ['backend_code']],
      ['api_design', ['spec'], ['api_spec']],
      ['unit_tests', ['frontend_code', 'backend_code'], ['unit_tests']],
      ['integration_tests', ['frontend_code', 'backend_code', 'api_spec'], ['integration_tests']],
      ['security_review', ['frontend_code', 'backend_code', 'api_spec'], ['security_report']],
      ['competitor_search', ['query'], ['competitor_data']],
      ['market_analysis', ['competitor_data', 'domains'], ['market_report']],
      ['quality_check', ['unit_tests', 'integration_tests', 'security_report'], ['quality_report']],
      ['report_assemble', ['market_report', 'quality_report'], ['answer']],
      ['answer_direct', ['competitor_data'], ['answer']],
    ];
    const registry = make_registry(v3_like);
    const result = await make_assembler(registry).assemble(
      make_request(['market_report', 'answer'], { entry: ['user_query'], top_k: 3 }),
    );
    expect(result.is_empty).toBe(false);
    const chains = result.candidates.map((c) => c.chain);
    expect(chains.some((chain) => chain.includes('competitor_search'))).toBe(true);
    expect(chains.some((chain) => chain.includes('market_analysis'))).toBe(true);
    for (const chain of chains) {
      const [ok, reasons] = validate_chain(chain, {
        pool: pool_of(registry),
        goal_fields: ['market_report', 'answer'],
        entry_fields: ['user_query'],
      });
      expect(ok).toBe(true);
      expect(reasons).toEqual([]);
    }
  });
});

describe('多径判据与冷启动指数（带证据）', () => {
  it('test_multipath_signal_cold_start_triggers：零证据（样本不足）→ 触发', async () => {
    const result = await make_assembler().assemble(make_request(['answer']));
    expect(result.multipath_signal).toBe(true);
  });

  it('test_multipath_signal_strong_evidence_no_trigger：证据强且分差大 → 不触发', async () => {
    const registry = make_registry();
    const store = new EdgeEvidenceStore();
    await store.put({
      key: edge_key('intent_parse', 'domain_router'),
      success_count: 30,
      fail_count: 0,
      avg_cost: 1.0,
      policy: false,
      origin: 'runtime',
      last_used_at: DUMMY_NOW,
      created_at: DUMMY_NOW,
    });
    await store.put({
      key: edge_key('domain_router', 'web_search'),
      success_count: 30,
      fail_count: 0,
      avg_cost: 1.0,
      policy: false,
      origin: 'runtime',
      last_used_at: DUMMY_NOW,
      created_at: DUMMY_NOW,
    });
    await store.put({
      key: edge_key('web_search', 'answer_direct'),
      success_count: 30,
      fail_count: 0,
      avg_cost: 1.0,
      policy: false,
      origin: 'runtime',
      last_used_at: DUMMY_NOW,
      created_at: DUMMY_NOW,
    });
    await store.put({
      key: edge_key('qa_check', 'report_assemble'),
      success_count: 5,
      fail_count: 0,
      avg_cost: 9.0,
      policy: false,
      origin: 'runtime',
      last_used_at: DUMMY_NOW,
      created_at: DUMMY_NOW,
    });
    const result = await make_assembler(registry, { store }).assemble(make_request(['answer']));
    const top = result.candidates[0]!;
    expect(top.chain[top.chain.length - 1]).toBe('answer_direct');
    expect(result.multipath_signal).toBe(false);
    await store.close();
  });

  it('test_cold_start_index_with_evidence：部分边有证据 → 指数 > 0 且 < 1；仍探索', async () => {
    const registry = make_registry();
    const store = new EdgeEvidenceStore();
    await store.put({
      key: edge_key('web_search', 'answer_direct'),
      success_count: 40,
      fail_count: 0,
      avg_cost: 0.0,
      policy: false,
      origin: 'runtime',
      last_used_at: DUMMY_NOW,
      created_at: DUMMY_NOW,
    });
    const result = await make_assembler(registry, { store }).assemble(make_request(['answer']));
    expect(result.cold_start_index).toBeGreaterThan(0.0);
    expect(result.cold_start_index).toBeLessThan(1.0);
    expect(result.exploration_mode).toBe(true);
    await store.close();
  });

  it('test_retriever_protocol_injected：注入内存检索器与默认兜底等价可用', async () => {
    const registry = make_registry();
    const retriever = new InMemoryPoolRetriever(pool_of(registry));
    const result = await make_assembler(registry, { retriever }).assemble(make_request(['answer']));
    expect(result.is_empty).toBe(false);
  });
});

describe('开关零生效 / 空结果原因', () => {
  it('test_assemble_empty_goal_returns_empty_with_reason：目标未声明字段 = 空 + 原因', async () => {
    const result = await make_assembler().assemble(make_request([]));
    expect(result.is_empty).toBe(true);
    expect(result.fallback_reason).toContain('未声明字段');
  });

  it('test_flag_disabled_zero_effect：config 默认关 → 零候选', async () => {
    const result = await make_assembler(null, {
      config: new PathAssemblyConfig(),
    }).assemble(make_request(['answer']));
    expect(result.is_empty).toBe(true);
    expect(Object.keys(result.stats)).toEqual([]);
  });

  it('test_flag_enabled_round_trip：开关形态序列化往返后 enabled 语义一致', async () => {
    const config = PathAssemblyConfig.from_dict(
      new PathAssemblyConfig({ enabled: true }).to_dict(),
    );
    expect(config.enabled).toBe(true);
    const result = await make_assembler(null, { config }).assemble(make_request(['answer']));
    expect(result.is_empty).toBe(false);
  });
});

// ── defer 说明 ──────────────────────────────────────────────────────────
// 依赖引擎执行器（executor.Engine 未迁移）的用例按迁移批次 defer，待 executor
// 模块落地后补测：
//   test_integration_candidate_roundtrip_and_canary_run（engine 单回合试跑，
//   由 conftest.make_engine 驱动）
//   test_assemble_plan_runtime_canary_and_audit（canary=True 单回合验证；
//   本批次以 canary=False 重建级变体覆盖装配层链路，见 runtime 测试）
//   test_canary_active_context_flag / test_canary_step_budget_caps_execution
//   test_canary_timeout_aborts / test_canary_round_rejects_broken_execution
