/**
 * 多径运行器零生效/防御路径测（test_multipath.py 硬规则段 1:1 移植）：
 * 开关关闭零生效（不触发/不执行支流/不留审计；Junction 类型不存在）与
 * 无候选不触发的防御路径。
 *
 * MultipathRunner.run 的触发路径（支流执行）依赖引擎执行器（executor 未
 * 迁移）——对应集成/中断/预算降级/嵌套护栏/接线类用例随本文尾注一并
 * defer；此处只跑无需真实支流执行的零生效/空候选路径（引擎以最小只读
 * 面 stub 注入，运行期不触达）。
 */

import { describe, expect, it } from 'vitest';

import { AssemblyRequest } from '../../../src/core/path_assembler/index.js';
import { PathAssemblyFlags } from '../../../src/core/contracts/contracts.js';
import { NodeTypeRegistry } from '../../../src/core/registry/registry.js';
import {
  JUNCTION_TYPE,
  MultiPathConfig,
  MultipathRunner,
  multipath_config_from_flags,
} from '../../../src/core/multipath/index.js';
import type { MultipathEngineLike } from '../../../src/core/multipath/index.js';
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

/** 最小只读面引擎 stub（零生效/空候选路径不触达引擎内部）。 */
function stub_engine(): MultipathEngineLike {
  return { options: { budget: null } };
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

// ── defer 说明 ──────────────────────────────────────────────────────────
// 依赖引擎执行器（executor.Engine 未迁移）的 MultipathRunner.run 触发路径
// 用例按迁移批次 defer，待 executor 模块落地后补测：
//   test_integration_quality_gate_winner / test_all_branches_fail_fallbacks
//   test_flags_wired_config_propagates / test_runner_requires_min_two_candidates
//   test_executor_multipath_dispatch / test_executor_multipath_degraded_single_
//   when_flag_off / test_executor_multipath_absent_flag_no_dispatch /
//   test_executor_multipath_passes_pending_inject
// （降级单径/集成闭环/中断挂起与注入隔离等见 multipath_unit.test.ts defer 说明）
