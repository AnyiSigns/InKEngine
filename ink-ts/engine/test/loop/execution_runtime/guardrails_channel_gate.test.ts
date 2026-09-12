/**
 * 护栏与通道条件测试（guardrails.ts / channel_gate.ts）。
 *
 * 测什么：
 * - 护栏三线（步数/成本/并行）命名常量 + 纯判定：超限 = fail-closed 阻断；
 *   配置 0/关闭 = 放行；归一配置缺省补默认档；
 * - 通道条件资格（命中放行 / 拒绝 eligibility_denied）、最大并行
 *   （max_parallel_exceeded）、成本池（cost_pool_exceeded）；
 * - 审批条件执行：accept/auto 放行；reject 阻断（approval_denied）；缺省
 *   审批 seam = 全拒（fail-closed：审批档声明即阻断）；
 * - 审批档缺省（null）不弹审批。
 */
import { describe, expect, it } from 'vitest';

import { ChannelSpec } from '../../../src/model/channels/channel_spec.js';
import {
  default_approval_seam,
  enforce_transition_conditions,
  eligibility_allowed,
  parallel_allowed,
  cost_pool_allowed,
} from '../../../src/loop/execution_runtime/channel_gate.js';
import {
  GUARDRAIL_DEFAULT_MAX_STEPS,
  check_cost_guard,
  check_parallel_guard,
  check_steps_guard,
  normalize_guardrails,
} from '../../../src/loop/execution_runtime/guardrails.js';

type Approval = 'accept' | 'auto' | 'reject';
const approve = async (d: Approval): Promise<Approval> => d;

function specWith(over: { approval?: 'L0' | 'L1' | 'L2' | null; eligibility?: string[]; max_parallel?: number | null; cost_pool_cap?: number | null }): ChannelSpec {
  return new ChannelSpec({
    id: 'c1',
    shape: 'fan_out',
    conditions: {
      approval: over.approval ?? null,
      eligibility: over.eligibility,
      max_parallel: over.max_parallel ?? null,
      cost_pool_cap: over.cost_pool_cap ?? null,
    },
  });
}

describe('护栏：命名常量 + 纯判定', () => {
  it('出厂默认档常量存在且为正', () => {
    expect(GUARDRAIL_DEFAULT_MAX_STEPS).toBeGreaterThan(0);
    const guards = normalize_guardrails({});
    expect(guards.max_steps).toBe(GUARDRAIL_DEFAULT_MAX_STEPS);
    expect(guards.max_cost).toBeGreaterThan(0);
    expect(guards.max_parallel).toBeGreaterThan(0);
  });

  it('步数护栏：超限阻断（fail-closed），未超放行；0 = 关闭', () => {
    const guards = normalize_guardrails({ max_steps: 2 });
    expect(check_steps_guard(1, guards).ok).toBe(true);
    const blocked = check_steps_guard(2, guards);
    expect(blocked.ok).toBe(false);
    expect(blocked.rule).toBe('steps');
    expect(check_steps_guard(100, normalize_guardrails({ max_steps: 0 })).ok).toBe(true);
  });

  it('成本护栏：累计 + 增量超限阻断；0 = 关闭', () => {
    const guards = normalize_guardrails({ max_cost: 10 });
    expect(check_cost_guard(5, 5, guards).ok).toBe(true);
    const blocked = check_cost_guard(5, 6, guards);
    expect(blocked.ok).toBe(false);
    expect(blocked.rule).toBe('cost');
    expect(check_cost_guard(1e6, 1e6, normalize_guardrails({ max_cost: 0 })).ok).toBe(true);
  });

  it('并行护栏：fan_out 路数超限阻断；0 = 关闭', () => {
    const guards = normalize_guardrails({ max_parallel: 4 });
    expect(check_parallel_guard(4, guards).ok).toBe(true);
    const blocked = check_parallel_guard(5, guards);
    expect(blocked.ok).toBe(false);
    expect(blocked.rule).toBe('parallel');
    expect(check_parallel_guard(99, normalize_guardrails({ max_parallel: 0 })).ok).toBe(true);
  });
});

describe('通道条件：资格 / 最大并行 / 成本池', () => {
  it('资格空 = 放行；资格非空含当前作用域 = 放行；不含 = eligibility_denied', () => {
    expect(eligibility_allowed(specWith({}), 'main').ok).toBe(true);
    expect(eligibility_allowed(specWith({ eligibility: ['planner'] }), 'planner').ok).toBe(true);
    const denied = eligibility_allowed(specWith({ eligibility: ['planner'] }), 'main');
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe('eligibility_denied');
  });

  it('最大并行：声明路数 ≤ 上限放行；超限 = max_parallel_exceeded', () => {
    expect(parallel_allowed(specWith({ max_parallel: 3 }), 3).ok).toBe(true);
    const blocked = parallel_allowed(specWith({ max_parallel: 2 }), 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('max_parallel_exceeded');
    expect(parallel_allowed(specWith({ max_parallel: null }), 99).ok).toBe(true);
  });

  it('成本池：累计 + 增量超上限 = cost_pool_exceeded', () => {
    expect(cost_pool_allowed(specWith({ cost_pool_cap: 10 }), { currentScope: 'm', accumulated_cost: 5, cost_increment: 5 }).ok).toBe(true);
    const blocked = cost_pool_allowed(specWith({ cost_pool_cap: 10 }), { currentScope: 'm', accumulated_cost: 6, cost_increment: 5 });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('cost_pool_exceeded');
  });
});

describe('通道条件全量执行（含审批 seam）', () => {
  const ctx = { currentScope: 'main', accumulated_cost: 0 };

  it('审批档 null：不弹审批直接放行', async () => {
    const verdict = await enforce_transition_conditions(specWith({}), ctx, 1, default_approval_seam());
    expect(verdict).toBeNull();
  });

  it('审批档声明 + accept = 放行；auto = 放行', async () => {
    const accept = await enforce_transition_conditions(specWith({ approval: 'L1' }), ctx, 1, () => approve('accept'));
    expect(accept).toBeNull();
    const auto = await enforce_transition_conditions(specWith({ approval: 'L1' }), ctx, 1, () => approve('auto'));
    expect(auto).toBeNull();
  });

  it('审批档声明 + reject = approval_denied（fail-closed）', async () => {
    const blocked = await enforce_transition_conditions(specWith({ approval: 'L1' }), ctx, 1, () => approve('reject'));
    expect(blocked?.ok).toBe(false);
    expect(blocked?.reason).toBe('approval_denied');
  });

  it('缺省审批 seam = 全拒（审批档声明即阻断，宁拒勿放）', async () => {
    const blocked = await enforce_transition_conditions(specWith({ approval: 'L2' }), ctx, 1, default_approval_seam());
    expect(blocked?.ok).toBe(false);
    expect(blocked?.reason).toBe('approval_denied');
  });

  it('资格墙在审批前生效（任一条件不过即阻断）', async () => {
    const blocked = await enforce_transition_conditions(
      specWith({ eligibility: ['planner'], approval: 'L1' }),
      ctx,
      1,
      () => approve('accept'),
    );
    expect(blocked?.reason).toBe('eligibility_denied');
  });
});
