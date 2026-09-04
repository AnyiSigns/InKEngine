/**
 * 样例库闸门对标测试（逐点对标 test_rules.py 样例库段）。
 *
 * 覆盖：样例全量评估与闸门放行/拒绝（期望类别子集语义、违规类别缺失
 * 报告）；样例库/用例序列化往返（最小形态不落盘）；用例声明类型闸门；
 * 回归防线（削弱既有规则立即被拦截）；静默失效防线（干净用例上谓词
 * 异常不得骗过闸门）；严格模式（unexpected_kinds 拒绝期望类别之外的
 * 额外违规）。
 */
import { describe, expect, it } from 'vitest';

import { FixtureGateError, GraphDefinitionError } from '../../../src/core/errors.js';
import {
  FixtureCase,
  FixtureSet,
  Rule,
  RuleEngine,
  RuleSet,
  RuleTypeRegistry,
  assert_fixtures_pass,
  fixtures_all_green,
  run_fixtures,
} from '../../../src/core/rules/index.js';

function fixtures(): FixtureSet {
  return new FixtureSet({
    name: 'demo',
    cases: [
      new FixtureCase({ id: 'pass', data: { x: 1 } }),
      new FixtureCase({
        id: 'violate',
        data: { x: 0 },
        expected_pass: false,
        expected_kinds: ['demo'],
      }),
    ],
  });
}

describe('样例库闸门', () => {
  it('test_run_fixtures_and_gate：样例闸门放行/拒绝（失败明细可审计）', () => {
    const ruleSet = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'truthy', config: { path: 'x' }, kind: 'demo' })],
    });
    const results = run_fixtures(ruleSet, fixtures());
    const byId = new Map(results.map((r) => [r.case_id, r]));
    expect(byId.get('pass')!.passed).toBe(true);
    expect(byId.get('violate')!.passed).toBe(true);
    expect(fixtures_all_green(ruleSet, fixtures())).toBe(true);
    assert_fixtures_pass(ruleSet, fixtures());

    // 规则过严：violate 用例期望违规，规则却放行 → 闸门拒绝
    const lenient = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'falsy', config: { path: 'x' } })],
    });
    expect(fixtures_all_green(lenient, fixtures())).toBe(false);
    expect(() => assert_fixtures_pass(lenient, fixtures())).toThrow(FixtureGateError);
    expect(() => assert_fixtures_pass(lenient, fixtures())).toThrow(/期望至少一条违规/);
  });

  it('test_fixture_expected_kinds_missing_reported：期望类别缺失 → 报告缺失类别', () => {
    const ruleSet = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'falsy', config: { path: 'x' }, kind: 'other' })],
    });
    const result = run_fixtures(ruleSet, fixtures())[1]!;
    expect(result.passed).toBe(false);
    expect(result.missing_kinds).toEqual(['demo']);
  });

  it('test_fixture_set_round_trip：样例库/用例序列化往返完整还原', () => {
    const rebuilt = FixtureSet.from_dict(fixtures().to_dict());
    expect(rebuilt.name).toBe('demo');
    expect(rebuilt.cases[1]!.expected_pass).toBe(false);
    expect(rebuilt.cases[1]!.expected_kinds).toEqual(['demo']);
    // 全通过样例缺省序列化为最小形态（expected_pass 不落盘）
    expect(rebuilt.cases[0]!.to_dict()).not.toHaveProperty('expected_pass');
  });

  it('test_fixture_case_from_dict_rejects_malformed：用例声明类型闸门', () => {
    expect(() => FixtureCase.from_dict({ data: {} })).toThrow(/缺 id/);
    expect(() => FixtureCase.from_dict({ id: 'c', data: 'nope' })).toThrow(/data/);
    expect(() => FixtureCase.from_dict({ id: 'c', data: {}, expected_kinds: 'nope' })).toThrow(
      /expected_kinds/,
    );
    expect(() => FixtureCase.from_dict('nope')).toThrow(GraphDefinitionError);
  });

  it('test_fixture_gate_catches_rule_regression：削弱既有规则立即被拦截', () => {
    const full = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'truthy', config: { path: 'x' }, kind: 'demo' })],
    });
    const regressed = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'truthy', config: { path: 'unrelated' } })],
    });
    expect(fixtures_all_green(full, fixtures())).toBe(true);
    expect(fixtures_all_green(regressed, fixtures())).toBe(false);
  });

  it('test_fixture_gate_rejects_silently_broken_rule：静默失效规则不得骗过闸门', () => {
    const registry = new RuleTypeRegistry();
    registry.register('broken', () => {
      throw new Error('谓词内部错误');
    });
    const ruleSet = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'broken', config: { path: 'x' }, kind: 'demo' })],
    });
    const fixtures = new FixtureSet({
      name: 'demo',
      cases: [new FixtureCase({ id: 'pass', data: { x: 1 } })],
    });
    const results = run_fixtures(ruleSet, fixtures, { engine: new RuleEngine(registry) });
    expect(results[0]!.passed).toBe(false); // 干净用例因规则失效而失败
    expect(results[0]!.reason).toContain('规则失效');
    expect(fixtures_all_green(ruleSet, fixtures, { engine: new RuleEngine(registry) })).toBe(
      false,
    );
    expect(() =>
      assert_fixtures_pass(ruleSet, fixtures, { engine: new RuleEngine(registry) }),
    ).toThrow(/规则失效/);
  });

  it('test_fixture_unexpected_kinds_strict_mode：严格模式拒绝额外类别', () => {
    const ruleSet = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'truthy', config: { path: 'x' }, kind: 'demo' })],
    });
    // 期望 demo 类违规出现；出现其他类别（order 类）→ 拒绝
    const strict = new FixtureSet({
      name: 'demo-strict',
      cases: [
        new FixtureCase({
          id: 'violate',
          data: { x: 0 },
          expected_pass: false,
          expected_kinds: ['demo'],
          unexpected_kinds: ['order'],
        }),
      ],
    });
    expect(fixtures_all_green(ruleSet, strict)).toBe(true);

    const noisy = new RuleSet({
      name: 't',
      rules: [new Rule({ id: 'a', predicate: 'truthy', config: { path: 'x' }, kind: 'order' })],
    });
    expect(fixtures_all_green(noisy, strict)).toBe(false);
    const result = run_fixtures(noisy, strict)[0]!;
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('禁止的违规类别');

    // 严格模式序列化往返保留
    const rebuilt = FixtureSet.from_dict(strict.to_dict());
    expect(rebuilt.cases[0]!.unexpected_kinds).toEqual(['order']);
  });
});