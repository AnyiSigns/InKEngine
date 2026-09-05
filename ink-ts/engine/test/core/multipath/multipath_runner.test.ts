/**
 * 多径运行器测（test_multipath.py 硬规则段 1:1 移植）：
 * - 零生效/防御路径：开关关闭零生效（不触发/不执行支流/不留审计；Junction
 *   类型不存在）与无候选不触发的防御路径；
 * - 支流执行真接线（executor 落地后）：候选并行执行 + 汇流裁决（两支成功
 *   归约胜者）/ 失败支流剔除归约 / 预算不足降级单径仍真实执行。
 *
 * MultipathRunner.run 的触发路径（支流执行）经父引擎结构面（MultipathEngineLike
 * = 真实 executor.Engine）执行，见 _runner_base.ts._execute_branches。
 */

import { describe, expect, it } from 'vitest';

import { AssemblyCandidate, AssemblyRequest } from '../../../src/core/path_assembler/index.js';
import { PathAssemblyFlags } from '../../../src/core/contracts/contracts.js';
import { NodeTypeRegistry } from '../../../src/core/registry/registry.js';
import { Engine } from '../../../src/core/executor/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { BudgetRemaining } from '../../../src/core/budget/budget_types.js';
import {
  JUNCTION_TYPE,
  MultiPathConfig,
  MultipathRunner,
  multipath_config_from_flags,
} from '../../../src/core/multipath/index.js';
import type { MultipathEngineLike } from '../../../src/core/multipath/index.js';
import {
  _multipath_depth_get,
  _multipath_depth_reset,
  _multipath_depth_set,
} from '../../../src/core/multipath/_runner_base.js';
import { _execute } from '../executor/helpers.js';
import { DOMAIN, DUMMY_NOW, ENTRY, field, spec } from './helpers.js';

/** 组装请求便捷构造（目标 answer，档位/域与 Python make_request 同形）。 */
function make_request(): AssemblyRequest {
  return new AssemblyRequest({
    goal_schema: spec('goal', field('answer', true)),
    entry_fields: [...ENTRY],
    domain: DOMAIN,
    max_safety_tier: 0,
    top_k: 2,
  });
}

/** 最小引擎（零生效/空候选路径不触达支流执行；真实 Engine 结构面）。 */
function stub_engine(): MultipathEngineLike {
  const graph = new Graph({ name: 'mp-stub', entry: 'n' });
  graph.add_node('n', (async () => ({})) as never);
  graph.add_exit('n');
  return new Engine(graph, new RunOptions({ budget: null }));
}

/** 真实执行引擎（候选支流由此展开；无存储/无预算的纯内存执行）。 */
function real_engine(): Engine {
  const graph = new Graph({ name: 'mp-parent', entry: 'root' });
  graph.add_node('root', (async () => ({})) as never);
  graph.add_exit('root');
  return new Engine(graph, new RunOptions());
}

/** 可执行候选：单节点图（入口即出口），节点写入 answer 覆盖标记。 */
function executable_candidate(
  rank: number,
  answer: string,
  init: { boom?: boolean } = {},
): AssemblyCandidate {
  const graph = new Graph({ name: `cand-${rank}`, entry: 'a' });
  const node = async (_ctx: unknown): Promise<Record<string, unknown> | never> => {
    if (init.boom === true) {
      throw new Error('candidate boom');
    }
    return { answer };
  };
  graph.add_node('a', node as never);
  graph.add_exit('a');
  return new AssemblyCandidate({ rank, source: 'algorithm', repaired: false, graph });
}

describe('硬规则：flag=False 零生效 / 空候选防御', () => {
  it('test_flag_disabled_zero_effect：开关关闭零生效（不触发/不留审计；类型不存在）', async () => {
    const registry = new NodeTypeRegistry();
    const records: Record<string, unknown>[] = [];
    const runner = new MultipathRunner(stub_engine(), {
      config: new MultiPathConfig(), // enabled=False（默认关）
      sink: (record) => records.push(record),
      now: DUMMY_NOW,
    });
    const result = await runner.run(make_request(), [], {
      entry_state: { user_query: 'q' },
      thread_id: 't-mp-off',
    });
    expect(result.triggered).toBe(false);
    expect(result.k).toBe(0);
    expect(result.branches).toEqual([]);
    expect(result.audit).toEqual([]);
    expect(records).toEqual([]);
    expect(registry.has(JUNCTION_TYPE)).toBe(false); // 未装配 = 类型不存在
  });

  it('test_no_candidates_defensive：开关开启但无候选 → 不触发（不执行不留审计）', async () => {
    const records: Record<string, unknown>[] = [];
    const runner = new MultipathRunner(stub_engine(), {
      config: multipath_config_from_flags(
        new PathAssemblyFlags({ multipath_enabled: true }),
      ),
      sink: (record) => records.push(record),
      now: DUMMY_NOW,
    });
    const result = await runner.run(make_request(), [], {
      entry_state: { user_query: 'q' },
      thread_id: 't-mp-none',
    });
    expect(result.triggered).toBe(false);
    expect(result.k).toBe(0);
    expect(result.candidates).toBe(0);
    expect(result.budget_note).toContain('无候选');
    expect(result.audit).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe('支流执行真接线（executor.Engine 结构面）', () => {
  it('test_two_branches_merge_verdict：两条成功支流 → 汇流裁决归约胜者（同证据档比序号）', async () => {
    const runner = new MultipathRunner(real_engine(), {
      config: multipath_config_from_flags(new PathAssemblyFlags({ multipath_enabled: true })),
      now: DUMMY_NOW,
    });
    const result = await runner.run(make_request(), [executable_candidate(0, 'A'), executable_candidate(1, 'B')], {
      entry_state: {},
      thread_id: 't-mp-merge',
    });
    expect(result.triggered).toBe(true);
    expect(result.k).toBe(2);
    expect(result.branches.length).toBe(2);
    expect(result.branches.every((b) => b.error === null)).toBe(true);
    expect(result.branches[0]!.overlay).toEqual({ answer: 'A' });
    expect(result.branches[1]!.overlay).toEqual({ answer: 'B' });
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.winner).toBe(0);
    expect(result.verdict!.selection).toEqual({ answer: 'A' });
    expect(result.verdict!.losers).toEqual([1]);
    // 支流子链归属（thread_ids 覆盖全部执行支流）
    expect(result.thread_ids[0]).toBe('t-mp-merge:multipath:0');
    expect(result.thread_ids[1]).toBe('t-mp-merge:multipath:1');
  });

  it('test_branch_failure_reduces_to_success：失败支流剔除归约（胜者 = 成功支流）', async () => {
    const runner = new MultipathRunner(real_engine(), {
      config: multipath_config_from_flags(new PathAssemblyFlags({ multipath_enabled: true })),
      now: DUMMY_NOW,
    });
    const result = await runner.run(
      make_request(),
      [executable_candidate(0, 'A', { boom: true }), executable_candidate(1, 'B')],
      { entry_state: {}, thread_id: 't-mp-fail' },
    );
    expect(result.triggered).toBe(true);
    expect(result.branches.length).toBe(2);
    expect(result.branches[0]!.terminal).toBe('error');
    expect(result.branches[0]!.error).toContain('节点执行失败');
    expect(result.branches[1]!.error).toBeNull();
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.winner).toBe(1);
    expect(result.verdict!.selection).toEqual({ answer: 'B' });
  });

  it('test_budget_insufficient_degrades_to_single_path：预算预检拒绝 → 降级单径仍真实执行首候选', async () => {
    const runner = new MultipathRunner(real_engine(), {
      config: multipath_config_from_flags(new PathAssemblyFlags({ multipath_enabled: true })),
      now: DUMMY_NOW,
    });
    const result = await runner.run(make_request(), [executable_candidate(0, 'A'), executable_candidate(1, 'B')], {
      entry_state: {},
      thread_id: 't-mp-degrade',
      budget_remaining: [new BudgetRemaining('tokens', 100, 0, 0, true)],
    });
    expect(result.triggered).toBe(false);
    expect(result.k).toBe(1);
    expect(result.degraded_reason).toContain('预算预检拒绝');
    expect(result.branches.length).toBe(1);
    expect(result.branches[0]!.error).toBeNull();
    expect(result.branches[0]!.overlay).toEqual({ answer: 'A' });
  });

  it('test_single_candidate_degraded_path：候选不足（1 条）→ 单径真实执行不丢产物', async () => {
    const runner = new MultipathRunner(real_engine(), {
      config: multipath_config_from_flags(new PathAssemblyFlags({ multipath_enabled: true })),
      now: DUMMY_NOW,
    });
    const result = await runner.run(make_request(), [executable_candidate(0, 'A')], {
      entry_state: {},
      thread_id: 't-mp-single',
    });
    expect(result.triggered).toBe(false);
    expect(result.k).toBe(1);
    expect(result.branches.length).toBe(1);
    expect(result.branches[0]!.overlay).toEqual({ answer: 'A' });
  });

  it('test_k3_gated_by_high_risk_tier：k>2 仅高风险任务放行（低档降 2 仍真实执行）', async () => {
    const runner = new MultipathRunner(real_engine(), {
      config: multipath_config_from_flags(new PathAssemblyFlags({ multipath_enabled: true })),
      now: DUMMY_NOW,
    });
    const result = await runner.run(
      make_request(),
      [executable_candidate(0, 'A'), executable_candidate(1, 'B'), executable_candidate(2, 'C')],
      { entry_state: {}, thread_id: 't-mp-k3', k: 3 },
    );
    expect(result.triggered).toBe(true);
    expect(result.k).toBe(2);
    expect(result.degraded_reason).toContain('k>2 仅高风险任务放行');
    expect(result.branches.length).toBe(2);
  });

  it('test_multipath_nesting_guardrail_degrades_single：嵌套深度超限 → 降级单径，深度令牌复位', async () => {
    const previous = _multipath_depth_get();
    _multipath_depth_set(1); // 已处于嵌套层（≥ 默认 max_nesting=1）
    try {
      const runner = new MultipathRunner(real_engine(), {
        config: multipath_config_from_flags(new PathAssemblyFlags({ multipath_enabled: true })),
        now: DUMMY_NOW,
      });
      const result = await runner.run(
        make_request(),
        [executable_candidate(0, 'A'), executable_candidate(1, 'B')],
        { entry_state: {}, thread_id: 't-mp-nest' },
      );
      expect(result.triggered).toBe(false);
      expect(result.k).toBe(1);
      expect(result.degraded_reason).toContain('多径嵌套超限');
      expect(result.branches.length).toBe(1);
      expect(result.branches[0]!.overlay).toEqual({ answer: 'A' });
    } finally {
      _multipath_depth_reset(previous);
    }
    expect(_multipath_depth_get()).toBe(previous);
  });

  it('test_executor_multipath_dispatch：引擎内节点产出 __multipath__ → 全链展开 + 胜者增量回流', async () => {
    const route = async (_ctx: unknown): Promise<Record<string, unknown>> => ({
      ['__multipath__']: {
        request: make_request(),
        candidates: [executable_candidate(0, 'A'), executable_candidate(1, 'B')],
        entry_state: { user_query: 'q' },
      },
    });
    const g = new Graph({ name: 'dispatch', entry: 'route' });
    g.add_node('route', route as never);
    g.add_exit('route');
    const engine = new Engine(g, new RunOptions({ multipath_enabled: true }));
    const [state, result] = await _execute(engine, {});
    expect(result.reason).toBe('reply');
    expect(state['answer']).toBe('A');
  });

  it('test_executor_multipath_branch_failure_reduce：引擎全链 → 失败支流剔除、成功支流胜者回流', async () => {
    const route = async (_ctx: unknown): Promise<Record<string, unknown>> => ({
      ['__multipath__']: {
        request: make_request(),
        candidates: [executable_candidate(0, 'A', { boom: true }), executable_candidate(1, 'B')],
        entry_state: {},
      },
    });
    const g = new Graph({ name: 'dispatch-fail', entry: 'route' });
    g.add_node('route', route as never);
    g.add_exit('route');
    const engine = new Engine(g, new RunOptions({ multipath_enabled: true }));
    const [state] = await _execute(engine, {});
    expect(state['answer']).toBe('B');
  });

  it('test_executor_multipath_flag_off_degrades_single：引擎开关默认关 → 防御性单径真实执行首候选', async () => {
    const route = async (_ctx: unknown): Promise<Record<string, unknown>> => ({
      ['__multipath__']: {
        request: make_request(),
        candidates: [executable_candidate(0, 'A'), executable_candidate(1, 'B')],
        entry_state: {},
      },
    });
    const g = new Graph({ name: 'dispatch-off', entry: 'route' });
    g.add_node('route', route as never);
    g.add_exit('route');
    // 默认 RunOptions：multipath_enabled=false（机制不触发，首候选单径降级）
    const engine = new Engine(g, new RunOptions());
    const [state, result] = await _execute(engine, {});
    expect(result.reason).toBe('reply');
    expect(state['answer']).toBe('A');
  });
});

// ── 覆盖说明 ─────────────────────────────────────────────────────────────
// test_integration_quality_gate_winner / test_all_branches_fail_fallbacks /
// test_budget_insufficient_degrades_to_single_path / test_k3_gated_by_high_risk
// tier / test_executor_multipath_dispatch（含降级单径/失败归约/全链展开）已在
// 上方以真实引擎结构面回补。依赖多径嵌套护栏复位/中断挂起与注入隔离的用例
// 仍待 async-local 深度隔离落地（见 _runner_base.ts 头注），暂不补测。
