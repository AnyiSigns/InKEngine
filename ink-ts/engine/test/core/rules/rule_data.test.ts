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
  RuleViolation,
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

describe('RuleViolation entity_id 往返对称', () => {
  it('数字/布尔实体锚点：构造期归一并往返稳定（反序列化不再炸）', () => {
    // 谓词/钩子可产出数字（如列表索引）实体锚点；构造期归一 string|null
    const numeric = new RuleViolation({
      rule_id: 'r',
      kind: 'rule',
      severity: SEVERITY_ERROR,
      message: '重复项',
      entity_id: 5,
    });
    expect(numeric.entity_id).toBe('5');
    const rebuilt = RuleViolation.from_dict(numeric.to_dict());
    expect(rebuilt.entity_id).toBe('5');
    expect(rebuilt.message).toBe('重复项');

    const flag = new RuleViolation({
      rule_id: 'r',
      kind: 'rule',
      severity: SEVERITY_ERROR,
      message: '状态位违规',
      entity_id: false,
    });
    expect(flag.entity_id).toBe('false');
    expect(RuleViolation.from_dict(flag.to_dict()).entity_id).toBe('false');
  });

  it('字符串/null 实体锚点往返稳定；对象/数组锚点归一为 null（不留垃圾串）', () => {
    const str = new RuleViolation({
      rule_id: 'r',
      kind: 'rule',
      severity: SEVERITY_ERROR,
      message: 'm',
      entity_id: 'c1',
    });
    expect(RuleViolation.from_dict(str.to_dict()).entity_id).toBe('c1');
    const none = new RuleViolation({
      rule_id: 'r',
      kind: 'rule',
      severity: SEVERITY_ERROR,
      message: 'm',
    });
    expect(none.entity_id).toBeNull();
    expect(RuleViolation.from_dict(none.to_dict()).entity_id).toBeNull();
    // 对象形态（无稳定标识）→ null 兜底，不再产生不可反序列化的记录
    const objectish = new RuleViolation({
      rule_id: 'r',
      kind: 'rule',
      severity: SEVERITY_ERROR,
      message: 'm',
      entity_id: { chapter: 1 } as unknown,
    });
    expect(objectish.entity_id).toBeNull();
  });

  it('遗留数字记录（to_dict 曾落 number）读取侧归一：from_dict 不炸', () => {
    const legacy = RuleViolation.from_dict({
      rule_id: 'r',
      kind: 'rule',
      severity: SEVERITY_ERROR,
      message: 'm',
      entity_id: 7,
    });
    expect(legacy.entity_id).toBe('7');
    // 对象形态仍拒绝（不是合法实体锚点）
    expect(() =>
      RuleViolation.from_dict({
        rule_id: 'r',
        kind: 'rule',
        severity: SEVERITY_ERROR,
        message: 'm',
        entity_id: { chapter: 1 },
      }),
    ).toThrow(/entity_id/);
  });
});