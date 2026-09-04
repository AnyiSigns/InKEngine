/**
 * 内置通用谓词对标测试（逐点对标 test_rules.py 谓词段）。
 *
 * 覆盖：present/absent、equals/compare（含 other_path 字段互比与类型
 * 不可比较跳过）、compare op 非法 fail-open 留痕、in_enum/not_contains、
 * unique_pairs 重复登记（实体锚点 = 组合末键，可经 entity_id_key 覆盖，
 * 缺键条目不参与）、state_transition 声明式状态机（终态单向）、点分
 * 路径的受限访问（下划线前缀段拒绝、对象公开属性可访问）。
 *
 * 谓词全部经 RuleEngine 全链路断言（Python _run 助手镜像）。
 */
import { describe, expect, it } from 'vitest';

import {
  RULE_TRANSITION,
  Rule,
  RuleEngine,
  RuleSet,
  RuleTypeRegistry,
} from '../../../src/core/rules/index.js';

function run(ruleSet: RuleSet, data: unknown, registry?: RuleTypeRegistry | null) {
  const engine = new RuleEngine(registry);
  return engine.evaluate(ruleSet, data);
}

describe('内置谓词', () => {
  it('test_builtin_present_absent：字段存在/缺失判定', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({ id: 'a', predicate: 'present', config: { path: 'x' }, kind: 't' }),
        new Rule({ id: 'b', predicate: 'absent', config: { path: 'y' }, kind: 't' }),
      ],
    });
    // x 存在 + y 缺失 = 双规则都通过
    expect(run(rules, { x: 1 }).issues).toEqual([]);
    // x 缺失 → present 违规；y 存在 → absent 违规
    const issues = run(rules, { y: 1 }).issues;
    expect(issues.map((i) => i.rule_id).sort()).toEqual(['a', 'b']);
    expect(issues[0]!.message).toBe('字段缺失: x');
  });

  it('test_builtin_equals_compare：等于/数值比较判定', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({ id: 'eq', predicate: 'equals', config: { path: 'kind', value: 'a' } }),
        new Rule({ id: 'gt', predicate: 'compare', config: { path: 'n', op: 'gt', value: 3 } }),
      ],
    });
    expect(run(rules, { kind: 'a', n: 5 }).issues).toEqual([]);
    const issues = run(rules, { kind: 'b', n: 2 }).issues;
    expect(issues.map((i) => i.rule_id).sort()).toEqual(['eq', 'gt']);
  });

  it('test_builtin_compare_other_path_and_missing_skip：字段互比 + 缺失不适用', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 'o',
          predicate: 'compare',
          config: { path: 'end', op: 'gte', other_path: 'start' },
        }),
      ],
    });
    expect(run(rules, { start: 3, end: 5 }).issues).toEqual([]);
    expect(run(rules, { start: 9, end: 5 }).issues.length).toBeGreaterThan(0);
    const result = run(rules, { start: 3 }); // end 缺失
    expect(result.issues).toEqual([]);
    expect(result.skipped).toEqual([]); // 缺字段 = 目标不适用，跳过留痕
    expect(result.checked).toBe(1);
  });

  it('test_builtin_compare_type_incomparable_skips：跨类型比较 = 规则不适用', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({ id: 's', predicate: 'compare', config: { path: 'x', op: 'gt', value: 1 } }),
      ],
    });
    // Python 语义：str 与 int 比较抛 TypeError → 谓词 fail-open 语义同
    // 「数据形态不适用」，不产违规
    expect(run(rules, { x: 'abc' }).issues).toEqual([]);
    expect(run(rules, { x: 'abc' }).skipped).toEqual([]);
  });

  it('test_builtin_compare_invalid_op_rejected：op 非法 = fail-open 跳过 + 留痕', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 'bad_op',
          predicate: 'compare',
          config: { path: 'n', op: 'approx', value: 1 },
        }),
      ],
    });
    const result = run(rules, { n: 2 });
    expect(result.issues).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0]![0]).toBe('bad_op');
    expect(result.skipped[0]![1]).toContain('op 非法');
  });

  it('test_builtin_in_enum_and_contains：枚举合法性/包含判定', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({ id: 'e', predicate: 'in_enum', config: { path: 's', values: ['a', 'b'] } }),
        new Rule({ id: 'c', predicate: 'contains', config: { path: 'text', value: '禁忌' } }),
        new Rule({ id: 'nc', predicate: 'not_contains', config: { path: 'text', value: '干净' } }),
      ],
    });
    // s 非法 → e 违规；正文不含「禁忌」→ c 违规；正文不含「干净」→ nc 通过
    const issues = run(rules, { s: 'z', text: '含禁忌词' }).issues;
    expect(issues.map((i) => i.rule_id)).toEqual(['e']);
    const issues2 = run(rules, { s: 'a', text: '正常内容' }).issues;
    expect(issues2.map((i) => i.rule_id)).toEqual(['c']);
    // 正文同时含「禁忌」与「干净」→ 仅 nc 违规
    const issues3 = run(rules, { s: 'a', text: '含禁忌词且干净' }).issues;
    expect(issues3.map((i) => i.rule_id)).toEqual(['nc']);
  });

  it('test_builtin_unique_pairs_detects_duplicates：组合重复登记 → 违规', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 'u',
          predicate: 'unique_pairs',
          config: { keys: ['cause', 'effect'] },
          target_path: 'links',
          kind: 'link',
        }),
      ],
    });
    const data = {
      links: [
        { cause: 'e1', effect: 'e2' },
        { cause: 'e1', effect: 'e2' },
        { cause: 'e3', effect: 'e4' },
      ],
    };
    const issues = run(rules, data).issues;
    expect(issues.length).toBe(1);
    expect(issues[0]!.entity_id).toBe('e2'); // 实体锚点 = 组合末键
    expect(issues[0]!.message).toContain('重复登记');
    // 实体锚点可经 entity_id_key 覆盖
    const anchored = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 'u',
          predicate: 'unique_pairs',
          config: { keys: ['cause', 'effect'], entity_id_key: 'cause' },
          target_path: 'links',
        }),
      ],
    });
    expect(run(anchored, data).issues[0]!.entity_id).toBe('e1');
    // 键字段缺失的条目不参与唯一性（不误报）
    const data2 = { links: [{ cause: 'e1' }, { cause: 'e1' }] };
    expect(run(rules, data2).issues).toEqual([]);
  });

  it('test_builtin_state_transition_rule：声明式状态机（终态单向）', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 't',
          predicate: 'state_transition',
          config: {
            states: ['draft', 'done'],
            terminal_states: ['done'],
            from_path: 'from_state',
            to_path: 'to_state',
          },
          type: RULE_TRANSITION,
        }),
      ],
    });
    // 终态转出 = 非法
    const issues = run(rules, { from_state: 'done', to_state: 'draft' }).issues;
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain('非法状态转换');
    // 合法转换零违规
    expect(run(rules, { from_state: 'draft', to_state: 'done' }).issues).toEqual([]);
    // 目标状态缺失 = 规则不适用
    expect(run(rules, { from_state: 'draft' }).issues).toEqual([]);
  });

  it('test_path_denies_private_segments：下划线前缀段拒绝访问（受限数据 DSL）', () => {
    const holder = { obj: { secret: 'sensitive' } };
    const rules = new RuleSet({
      name: 't',
      rules: [
        // dunder 段视为字段缺失（present 报违规），不返回对象内部属性
        new Rule({
          id: 'p',
          predicate: 'present',
          config: { path: 'obj.__class__' },
          target_path: 'holder',
        }),
      ],
    });
    const result = run(rules, { holder });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]!.message).toBe('字段缺失: obj.__class__');
    // 对象自身的公开属性仍可访问
    const publicRules = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 's',
          predicate: 'equals',
          config: { path: 'obj.secret', value: 'sensitive' },
          target_path: 'holder',
        }),
      ],
    });
    expect(run(publicRules, { holder }).issues).toEqual([]);
  });
});