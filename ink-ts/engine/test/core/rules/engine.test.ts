/**
 * 执行引擎对标测试（逐点对标 test_rules.py 执行段）。
 *
 * 覆盖：target_path 点分取值（规则作用域定位 + 目标路径不存在 = 跳过
 * 留痕）；谓词运行时异常 fail-open（跳过该规则并留痕、其余规则不受
 * 影响、checked 计数含失效规则）；未知谓词在执行期也是声明错误（抛错
 * 不静默跳过）；违规携带规则元数据（rule_id/kind/severity/entity_type）
 * 与序列化往返；has_hard_conflict 的 error 级判定。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  Rule,
  RuleEngine,
  RuleSet,
  RuleTypeRegistry,
  RuleViolation,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
} from '../../../src/core/rules/index.js';

describe('执行引擎', () => {
  it('test_target_path_extraction：点分取值定位子结构/目标缺失跳过', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 'sub',
          predicate: 'truthy',
          config: { path: 'enabled' },
          target_path: 'settings.sub',
        }),
      ],
    });
    expect(run(rules, { settings: { sub: { enabled: true } } }).issues).toEqual([]);
    expect(run(rules, { settings: { sub: { enabled: false } } }).issues.length).toBeGreaterThan(0);
    // 目标路径不存在 = 规则跳过（不适用），计入 skipped
    const result = run(rules, { settings: {} });
    expect(result.issues).toEqual([]);
    expect(result.skipped).toEqual([['sub', '目标路径不存在: settings.sub']]);
  });

  it('test_predicate_error_fail_open_skips_rule：谓词异常 fail-open 不阻断其余', () => {
    const registry = new RuleTypeRegistry();
    registry.register('boom', () => {
      throw new Error('内部错误');
    });
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({ id: 'bad', predicate: 'boom' }),
        new Rule({ id: 'ok', predicate: 'truthy', config: { path: 'x' } }),
      ],
    });
    const result = run(rules, { x: 1 }, registry);
    expect(result.issues).toEqual([]);
    expect(result.skipped).toContainEqual(['bad', '谓词执行异常（fail-open 跳过）: 内部错误']);
    expect(result.checked).toBe(2);
  });

  it('test_unknown_predicate_raises_at_evaluate：未知谓词执行期也是声明错误', () => {
    const rules = new RuleSet({ name: 't', rules: [new Rule({ id: 'x', predicate: 'ghost' })] });
    expect(() => run(rules, {})).toThrow(GraphDefinitionError);
    expect(() => run(rules, {})).toThrow(/未知谓词/);
  });

  it('test_violation_carries_rule_metadata：违规携带元数据 + 序列化往返', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 'x',
          predicate: 'in_enum',
          config: { path: 'status', values: ['ok'] },
          kind: 'demo',
          entity_type: 'thing',
        }),
      ],
    });
    const issue = run(rules, { status: 'bad' }).issues[0]!;
    expect(issue.rule_id).toBe('x');
    expect(issue.kind).toBe('demo');
    expect(issue.severity).toBe(SEVERITY_ERROR);
    expect(issue.entity_type).toBe('thing');
    const rebuilt = RuleViolation.from_dict(issue.to_dict());
    expect(rebuilt).toEqual(issue);
  });

  it('test_rule_check_result_has_hard_conflict：任一 error 级违规 = 硬冲突', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({ id: 'w', predicate: 'falsy', config: { path: 'a' }, severity: SEVERITY_WARNING }),
        new Rule({ id: 'e', predicate: 'falsy', config: { path: 'b' } }),
      ],
    });
    expect(run(rules, { a: true, b: true }).has_hard_conflict()).toBe(true);
    expect(run(rules, { a: true, b: false }).has_hard_conflict()).toBe(false);
  });

  it('test_iterate_items_over_dict_values：目标为字典时按值序列逐条执行', () => {
    const rules = new RuleSet({
      name: 't',
      rules: [
        new Rule({
          id: 'each',
          predicate: 'truthy',
          config: { path: 'enabled' },
          target_path: 'items',
          iterate_items: true,
          kind: 'demo',
        }),
      ],
    });
    const pass = run(rules, { items: { a: { enabled: true }, b: { enabled: 1 } } });
    expect(pass.issues).toEqual([]);
    const fail = run(rules, { items: { a: { enabled: false }, b: { enabled: true } } });
    expect(fail.issues.length).toBe(1);
    // 目标非集合形态 = 规则不适用（跳过留痕）
    const skipped = run(rules, { items: 5 });
    expect(skipped.issues).toEqual([]);
    expect(skipped.skipped).toEqual([['each', '目标非集合（iterate_items 需集合形态）']]);
  });
});

function run(ruleSet: RuleSet, data: unknown, registry?: RuleTypeRegistry | null) {
  const engine = new RuleEngine(registry);
  return engine.evaluate(ruleSet, data);
}