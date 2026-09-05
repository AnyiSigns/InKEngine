/**
 * 多径机制单元测（test_multipath.py 单元段 1:1 移植）：
 * ρ 成本核算公式 / 配置校验（径数与 ρ 越界显式拒绝）/ 预算预检 fail-closed
 * / max_nesting 配置往返 / 预算只读查询 ctx 字段稳定 / 装配按名开关接线 /
 * 候选链证据口径（边引用 + 链级聚合）。
 *
 * 引擎执行器接线类用例（executor 未迁移）已 defer（见本文尾注），本文件
 * 只跑多径纯算法/数据形态可复现路径。
 */

import { describe, expect, it } from 'vitest';

import { BOOT_KEY_MULTIPATH_ENABLED, PathAssemblyFlags } from '../../../src/core/contracts/contracts.js';
import { BudgetRemaining } from '../../../src/core/budget/budget_types.js';
import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/index.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import { MAX_MULTIPATH_NESTING } from '../../../src/core/multipath/constants.js';
import {
  BudgetView,
  DEFAULT_MULTIPATH_K,
  MultiPathConfig,
  chain_edge_refs,
  chain_evidence,
  chain_terminal_fields,
  check_multipath_budget,
  evidence_index_of,
  multipath_budget_required,
  multipath_config_from_flags,
} from '../../../src/core/multipath/index.js';
import {
  chain_candidate,
  contract,
  DOMAIN,
  DUMMY_NOW,
  evidence_row,
} from './helpers.js';

describe('成本核算公式 + 配置校验 + 预算预检', () => {
  it('test_rho_cost_formula：ρ 成本核算断言 B×(1+(k-1)×ρ)；k=1 恒等于 B', () => {
    expect(multipath_budget_required(100.0, 1, { rho: 0.3 })).toBeCloseTo(100.0, 6);
    expect(multipath_budget_required(100.0, 2, { rho: 0.3 })).toBeCloseTo(130.0, 6);
    expect(multipath_budget_required(100.0, 3, { rho: 0.3 })).toBeCloseTo(160.0, 6);
    // ρ 上界（无缓存）与下界（前缀命中理想情形）
    expect(multipath_budget_required(100.0, 3, { rho: 1.0 })).toBeCloseTo(300.0, 6);
    expect(multipath_budget_required(100.0, 2, { rho: 0.2 })).toBeCloseTo(120.0, 6);
  });

  it('test_config_validation：ρ 越界/径数非法显式拒绝（命名精确无魔法数字）', () => {
    new MultiPathConfig({ enabled: true }); // 默认合法
    expect(() => new MultiPathConfig({ shared_rho: 0.1 })).toThrow(GraphDefinitionError);
    expect(() => new MultiPathConfig({ shared_rho: 1.5 })).toThrow(GraphDefinitionError);
    expect(() => new MultiPathConfig({ default_k: 0 })).toThrow(GraphDefinitionError);
    expect(() => new MultiPathConfig({ default_k: 3, max_k: 2 })).toThrow(GraphDefinitionError);
    const cfg = MultiPathConfig.from_dict(
      new MultiPathConfig({ enabled: true }).to_dict(),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.default_k).toBe(DEFAULT_MULTIPATH_K);
  });

  it('test_budget_precheck_fail_closed：无维度放行；查询故障拒绝；余量不足拒绝', () => {
    const [ok0, note0] = check_multipath_budget([], 100.0, 2, { rho: 0.3 });
    expect(ok0).toBe(true);
    expect(note0).toContain('未启用预算语义');
    const [ok1] = check_multipath_budget(
      [new BudgetRemaining('tokens', 1000, 499, 500)],
      100.0,
      2,
      { rho: 0.3 },
    );
    expect(ok1).toBe(true);
    const [ok2, note2] = check_multipath_budget(
      [new BudgetRemaining('tokens', 1000, 0, 100.0)],
      100.0,
      2,
      { rho: 0.3 },
    );
    expect(ok2).toBe(false);
    expect(note2).toContain('预算预检拒绝');
    const [ok3, note3] = check_multipath_budget(
      [new BudgetRemaining('tokens', 1000, 0, 0, true)],
      100.0,
      2,
    );
    expect(ok3).toBe(false);
    expect(note3).toContain('不可确定');
  });
});

describe('多径嵌套护栏配置（max_nesting）', () => {
  it('test_multipath_config_max_nesting：可配 + 校验 + 序列化往返', () => {
    expect(new MultiPathConfig().max_nesting).toBe(MAX_MULTIPATH_NESTING);
    const config = new MultiPathConfig({ enabled: true, max_nesting: 0 });
    expect(config.to_dict()['max_nesting']).toBe(0);
    const restored = MultiPathConfig.from_dict(config.to_dict());
    expect(restored.max_nesting).toBe(0);
    expect(() => new MultiPathConfig({ max_nesting: -1 })).toThrow(GraphDefinitionError);
    expect(() =>
      new MultiPathConfig({ max_nesting: true as unknown as number }),
    ).toThrow(GraphDefinitionError);
  });
});

describe('预算只读查询 ctx / 装配接线', () => {
  it('test_budget_query_view_has_stable_fields：多径预检的轻量视图字段稳定', () => {
    const view = new BudgetView();
    expect(view.node).toBeNull();
    expect(view.graph_path).toEqual(['multipath']);
    expect(view.step_count).toBe(0);
  });

  it('test_flags_parse_boot_keys：按名读取（缺省全关/未知键忽略）', () => {
    const flags_off = PathAssemblyFlags.from_boot(null);
    expect(flags_off.multipath_enabled).toBe(false);
    expect(Object.values(flags_off.to_dict()).every((v) => v === false)).toBe(true);
    const flags = PathAssemblyFlags.from_boot({
      [BOOT_KEY_MULTIPATH_ENABLED]: true,
      unknown_key: true,
    });
    expect(flags.multipath_enabled).toBe(true);
    expect(flags.assembler_enabled).toBe(false);
    const cfg = multipath_config_from_flags(flags);
    expect(cfg.enabled).toBe(true);
    expect(cfg.shared_rho).toBeCloseTo(0.3, 6);
  });
});

describe('候选链证据口径', () => {
  it('test_chain_evidence_aggregation：边引用版本入键 + 链级证据聚合（预算基准 B 同源）', async () => {
    const candidate = chain_candidate('mp-evidence', [
      ['intent_parse', contract([], ['intent'])],
      ['domain_router', contract(['intent'], ['query'])],
      ['web_search', contract(['query'], ['search_results'])],
    ]);
    const refs = chain_edge_refs(candidate);
    expect(refs.length).toBe(2);
    expect(refs[0]!.src).toBe('intent_parse');
    expect(refs[0]!.dst).toBe('domain_router');
    expect(refs[0]!.src_version).toBe('1');
    expect(chain_terminal_fields(candidate)).toEqual(['search_results']);
    // 无命中 = 零证据口径（边数仍入账）
    const none = chain_evidence(candidate, new Map());
    expect(none.edges).toBe(2);
    expect(none.evidenced).toBe(0);
    expect(none.cost_estimate).toBe(0.0);
    // 落库证据 → 索引 → 聚合（B = 链边 avg_cost 合计，与预算预检数据源一致）
    const store = new EdgeEvidenceStore();
    for (const ref of refs) {
      await store.put(
        evidence_row(ref.src, ref.dst, { success: 10, avg_cost: 100.0, now: DUMMY_NOW }),
      );
    }
    const index = evidence_index_of(await store.list_edges(DOMAIN));
    const ce = chain_evidence(candidate, index);
    expect(ce.evidenced).toBe(2);
    expect(ce.success_total).toBe(20);
    expect(ce.fail_total).toBe(0);
    expect(ce.cost_estimate).toBeCloseTo(200.0, 6);
    await store.close();
  });
});

// ── 覆盖说明 ──────────────────────────────────────────────────────────
// 原 defer 的引擎执行类用例已回补于 multipath_runner.test.ts「支流执行真接线」
// （真实引擎结构面跑通）：
//   test_two_branches_merge_verdict（≈ test_integration_assemble_multipath_
//   junction_settle 的执行面）/ test_branch_failure_reduces_to_success（≈
//   test_all_branches_fail_fallbacks）/ test_budget_insufficient_degrades_to_
//   single_path / test_single_candidate_degraded_path（≈ 降级单径仍需执行）/
//   test_executor_multipath_dispatch（引擎全链展开）。k>2 高风险门限（k_eff 降 2）
//   的降档逻辑由 runner 内纯算法路径覆盖；依赖嵌套深度复位/中断挂起与注入
//   隔离的用例仍待 async-local 深度隔离落地（见 _runner_base.ts 头注）。
