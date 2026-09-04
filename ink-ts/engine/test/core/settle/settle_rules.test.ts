/**
 * 沉淀单元：判据纯函数（提案阈值 / 契约草案 / 晋升证据 / 策略边复审）。
 *
 * 对标 ink_engine/tests/test_settle.py 的 should_propose / draft_node_contract /
 * recommended_prior_eligible / policy_edge_needs_review 断言段。
 */

import { describe, expect, it } from 'vitest';

import type { EdgeEvidence } from '../../../src/core/edge_evidence/_types.js';
import {
  draft_node_contract,
  policy_edge_needs_review,
  recommended_prior_eligible,
  should_propose,
} from '../../../src/core/settle/rules.js';
import {
  PROPOSAL_FAIL_RATE,
  PROPOSAL_MIN_FAILS,
} from '../../../src/core/settle/_constants.js';
import { edgeKey, NOW } from './helpers.js';

/** 策略边证据构造（对标 test_settle.py 内部 edge() helper）。 */
function policyEdge(
  fail: number,
  opts: { success?: number; policy?: boolean } = {},
): EdgeEvidence {
  return {
    key: edgeKey('a', 'b'),
    success_count: opts.success ?? 0,
    fail_count: fail,
    avg_cost: 0.0,
    policy: opts.policy ?? true,
    origin: 'policy',
    last_used_at: NOW,
    created_at: NOW,
  };
}

describe('should_propose 提案判据', () => {
  it('N≥3 或失败率>0.4（≥2 样本），单次偶发不提案', () => {
    expect(should_propose(1, 0)).toBe(false); // 单样本偶发失败不污染评审队列
    expect(should_propose(1, 1)).toBe(true); // 2 样本失败率 0.5 > 0.4 → 提案
    expect(should_propose(2, 0)).toBe(true);
    expect(should_propose(2, 5)).toBe(false); // 2/7 ≈ 0.286 且 N<3 → 不提案
    expect(should_propose(3, 100)).toBe(true); // 累计失败 N≥3 → 提案
    expect(should_propose(2, 10)).toBe(false); // 2/12 ≈ 0.167 → 不提案
    expect(PROPOSAL_MIN_FAILS).toBe(3);
    expect(PROPOSAL_FAIL_RATE).toBe(0.4);
  });
});

describe('draft_node_contract 契约草案', () => {
  it('草案 = schema 声明（非代码）：input/output SchemaSpec 数据', () => {
    const draft = draft_node_contract('fixer', {
      consumes: ['code', 'tests'],
      produces: ['patch'],
    });
    expect(draft['node_type']).toBe('fixer');
    const input = draft['input_schema'] as Record<string, unknown>;
    expect(input['name']).toBe('fixer.input');
    const fields = input['fields'] as Array<Record<string, unknown>>;
    expect(fields.map((f) => f['name'])).toEqual(['code', 'tests']);
    expect(fields.every((f) => f['required'] === true)).toBe(true);
    const output = draft['output_schema'] as Record<string, unknown>;
    const outputFields = output['fields'] as Array<Record<string, unknown>>;
    expect(outputFields[0]!['name']).toBe('patch');
    // 去重保序
    const draft2 = draft_node_contract('x', { consumes: ['a', 'a', 'b'] });
    const input2 = draft2['input_schema'] as Record<string, unknown>;
    const fields2 = input2['fields'] as Array<Record<string, unknown>>;
    expect(fields2.map((f) => f['name'])).toEqual(['a', 'b']);
  });
});

describe('recommended_prior_eligible 晋升证据判据', () => {
  it('N≥30 且成功率≥0.9（与信任档推导同一组常数）', () => {
    expect(recommended_prior_eligible(30, 0)).toBe(true); // p̂=(31/32)=0.969 ≥0.9
    expect(recommended_prior_eligible(29, 0)).toBe(false); // N=29 不足
    expect(recommended_prior_eligible(30, 10)).toBe(false); // p̂ 不足
    expect(recommended_prior_eligible(27, 3)).toBe(false); // p̂=28/32=0.875 < 0.9
    expect(recommended_prior_eligible(28, 2)).toBe(true); // p̂=29/32=0.906 ≥0.9
  });
});

describe('policy_edge_needs_review 策略边复审判据', () => {
  it('失败累计≥5 或域均值反超承诺（样本不足只按失败判）', () => {
    expect(policy_edge_needs_review(policyEdge(5))).toEqual([
      true,
      '策略边失败累计 5 次 ≥ 阈值 5（对抗证据触发复审）',
    ]);
    expect(policy_edge_needs_review(policyEdge(4))[0]).toBe(false);
    // 域均值反超：策略边 p̂=9/10=0.833 < 域均值 0.9
    const overtake = policy_edge_needs_review(policyEdge(1, { success: 9 }), {
      domain_average_p: 0.9,
    });
    expect(overtake[0]).toBe(true);
    expect(overtake[1]).toContain('域均值反超');
    // 非策略边不触发（降级后不再重复提请）
    expect(policy_edge_needs_review(policyEdge(99, { policy: false }))[0]).toBe(
      false,
    );
  });
});
