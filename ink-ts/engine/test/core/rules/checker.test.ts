/**
 * 混合判定门面对标测试（逐点对标 test_rules.py 混合判定段）。
 *
 * 覆盖：LLM 钩子补充判定（确定性违规 + 钩子违规并集返回，钩子违规
 * rule_id = "__llm_hook__"）；钩子异常 fail-open（跳过钩子并留痕，
 * 确定性结果不受影响）；钩子返回形态非法条目（非 dict/缺 message）
 * 丢弃，不污染结果。
 */
import { describe, expect, it } from 'vitest';

import {
  ConstraintChecker,
  RULE_TRANSITION,
  Rule,
  RuleSet,
  type RawIssue,
} from '../../../src/core/rules/index.js';

function orderRule(): Rule {
  return new Rule({
    id: 'order.state_transition',
    predicate: 'state_transition',
    config: {
      states: ['draft', 'paid', 'shipped', 'done'],
      terminal_states: ['done'],
      from_path: 'from_state',
      to_path: 'to_state',
      name: 'order',
    },
    type: RULE_TRANSITION,
    kind: 'order_flow',
    description: '订单状态转换必须合法（终态单向）',
  });
}

function orderRules(): RuleSet {
  return new RuleSet({
    name: 'order.demo',
    rules: [
      orderRule(),
      new Rule({
        id: 'order.amount_positive',
        predicate: 'compare',
        config: { path: 'amount', op: 'gt', value: 0 },
        kind: 'order_amount',
        description: '订单金额必须为正',
      }),
    ],
  });
}

describe('混合判定（确定性规则 + LLM 钩子）', () => {
  it('test_constraint_checker_llm_hook_merges：钩子补充判定并集返回', async () => {
    const checker = new ConstraintChecker({
      llm_hook: async (_data: unknown, _context: unknown): Promise<RawIssue[]> => [
        { message: '语义深度偏离', kind: 'semantic', entity_id: 'c1' },
      ],
    });
    const ruleSet = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'truthy', config: { path: 'x' } })],
    });
    const result = await checker.check(ruleSet, { x: 1 });
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]!.rule_id).toBe('__llm_hook__');
    expect(result.issues[0]!.kind).toBe('semantic');
    expect(result.issues[0]!.message).toBe('语义深度偏离');
  });

  it('test_constraint_checker_hook_failure_fail_open：钩子异常跳过留痕', async () => {
    const checker = new ConstraintChecker({
      llm_hook: async () => {
        throw new Error('钩子故障');
      },
    });
    const ruleSet = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'truthy', config: { path: 'x' } })],
    });
    const result = await checker.check(ruleSet, { x: 1 });
    expect(result.issues).toEqual([]);
    expect(result.skipped).toContainEqual(['__llm_hook__', '钩子异常: 钩子故障']);
  });

  it('test_constraint_checker_hook_malformed_dropped：形态非法条目丢弃不污染结果', async () => {
    const checker = new ConstraintChecker({
      llm_hook: async (): Promise<RawIssue[]> =>
        [{ message: '有效' }, { no_message: true }, 'garbage'] as unknown as RawIssue[],
    });
    const result = await checker.check(orderRules(), {
      amount: 5,
      from_state: 'draft',
      to_state: 'paid',
    });
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]!.message).toBe('有效');
  });
});