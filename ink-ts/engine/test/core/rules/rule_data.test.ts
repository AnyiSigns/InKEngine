/**
 * 规则数据形态对标测试（逐点对标 test_rules.py 数据段）。
 *
 * 覆盖：Rule 序列化 → 重建的声明完整还原（含最小数据形态——缺省字段
 * 不参与序列化）；规则/规则集声明的类型闸门（缺 id/predicate、config
 * 非 dict、type/severity 枚举非法、target_path 形态非法 → 建图期拒绝）；
 * 规则集 parse 的谓词存在性与规则 id 唯一性校验。
 *
 * Python 冻结数据类的 == 在 TS 以 toEqual 结构比较表达（to_dict 形态
 * 对齐最小序列化契约）。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  RULE_CONSTRAINT,
  RULE_TRANSITION,
  Rule,
  RuleSet,
  RuleTypeRegistry,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
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

describe('规则数据形态', () => {
  it('test_rule_round_trip_preserves_declaration：规则序列化 → 重建完整还原', () => {
    const rule = new Rule({
      id: 'r1',
      predicate: 'compare',
      config: { path: 'count', op: 'lte', value: 3 },
      type: RULE_TRANSITION,
      target_path: 'sub.orders',
      severity: SEVERITY_WARNING,
      kind: 'demo',
      entity_type: 'order',
      description: '示例',
    });
    const rebuilt = Rule.from_dict(rule.to_dict());
    expect(rebuilt).toEqual(rule);
    // 缺省字段不参与序列化（最小数据形态）
    const minimal = Rule.from_dict(new Rule({ id: 'r2', predicate: 'truthy' }).to_dict());
    expect(minimal.type).toBe(RULE_CONSTRAINT);
    expect(minimal.severity).toBe(SEVERITY_ERROR);
    expect(minimal.target_path).toBeNull();
  });

  it('test_rule_from_dict_rejects_malformed：声明类型闸门—缺字段/枚举非法 → 拒绝', () => {
    expect(() => Rule.from_dict({ predicate: 'truthy' })).toThrow(GraphDefinitionError);
    expect(() => Rule.from_dict({ predicate: 'truthy' })).toThrow(/缺 id/);
    expect(() => Rule.from_dict({ id: 'r' })).toThrow(/缺 predicate/);
    expect(() => Rule.from_dict({ id: 'r', predicate: 'truthy', config: 'nope' })).toThrow(
      /config/,
    );
    expect(() =>
      Rule.from_dict({ id: 'r', predicate: 'truthy', type: 'magic' }),
    ).toThrow(/类型非法/);
    expect(() =>
      Rule.from_dict({ id: 'r', predicate: 'truthy', severity: 'fatal' }),
    ).toThrow(/严重度非法/);
    expect(() =>
      Rule.from_dict({ id: 'r', predicate: 'truthy', target_path: 5 }),
    ).toThrow(/target_path/);
  });

  it('test_rule_set_round_trip_and_parse：规则集重建 + parse 校验', () => {
    const ruleSet = orderRules();
    const rebuilt = RuleSet.from_dict(ruleSet.to_dict());
    expect(rebuilt.name).toBe('order.demo');
    expect(rebuilt.rules.length).toBe(2);
    const registry = new RuleTypeRegistry();
    const parsed = RuleSet.parse(ruleSet.to_dict(), registry);
    expect(parsed.name).toBe(ruleSet.name);
    // 未知谓词 = 声明错误（不延后到执行期静默跳过）
    const bad = new RuleSet({
      name: 'bad',
      rules: [new Rule({ id: 'x', predicate: 'not_a_predicate' })],
    });
    expect(() => RuleSet.parse(bad.to_dict(), registry)).toThrow(/未注册的谓词/);
    // 重复规则 id
    const dup = new RuleSet({
      name: 'dup',
      rules: [
        new Rule({ id: 'x', predicate: 'truthy' }),
        new Rule({ id: 'x', predicate: 'falsy' }),
      ],
    });
    expect(() => RuleSet.parse(dup.to_dict(), registry)).toThrow(/重复/);
  });
});