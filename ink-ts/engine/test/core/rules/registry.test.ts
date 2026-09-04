/**
 * 谓词注册表与 config 校验器对标测试（逐点对标 test_rules.py 注册表段）。
 *
 * 覆盖：谓词重复注册拒绝（含内置谓词不可覆盖）/未知谓词解析即报错；
 * parse 期的配置形态校验（compare op 非法/缺 value 侧、in_enum 缺
 * values、state_transition 缺 states）；state_transition 的引用合法性
 * 校验（terminal/allowed 引用未声明状态 → 建图期拒绝，合法引用 → 解析
 * 通过且白名单真实生效）；领域谓词可登记自己的 config 校验器。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  Rule,
  RuleEngine,
  RuleSet,
  RuleTypeRegistry,
} from '../../../src/core/rules/index.js';

describe('谓词注册表', () => {
  it('test_registry_rejects_duplicate_and_unknown：重复注册拒绝/未知谓词报错', () => {
    const registry = new RuleTypeRegistry();
    expect(() => registry.register('present', () => [])).toThrow(/重复注册/);
    expect(registry.names()).toContain('present'); // 内置通用谓词已登记
    expect(() => registry.create('ghost')).toThrow(/未知谓词/);
    expect(registry.names().length).toBe(13);
  });

  it('test_parse_rejects_invalid_predicate_config：config 形态校验在建图期暴露', () => {
    const registry = new RuleTypeRegistry();
    expect(() =>
      RuleSet.parse(
        {
          name: 't',
          rules: [
            { id: 'a', predicate: 'compare', config: { path: 'x', op: '~', value: 1 } },
          ],
        },
        registry,
      ),
    ).toThrow(/op 非法/);
    expect(() =>
      RuleSet.parse(
        {
          name: 't',
          rules: [{ id: 'a', predicate: 'compare', config: { path: 'x', op: 'gt' } }],
        },
        registry,
      ),
    ).toThrow(/value 或 other_path/);
    expect(() =>
      RuleSet.parse(
        {
          name: 't',
          rules: [{ id: 'a', predicate: 'in_enum', config: { path: 'x' } }],
        },
        registry,
      ),
    ).toThrow(/values/);
    expect(() =>
      RuleSet.parse(
        {
          name: 't',
          rules: [{ id: 'a', predicate: 'state_transition', config: {} }],
        },
        registry,
      ),
    ).toThrow(/states/);
    // 未注入注册表 = 不做 config 形态校验（向后兼容：无注册表只有数据）
    expect(() =>
      RuleSet.parse({
        name: 't',
        rules: [{ id: 'a', predicate: 'compare', config: { path: 'x', op: '~', value: 1 } }],
      }),
    ).not.toThrow();
  });

  // state_transition 规则声明（config 按参数覆盖，其余字段固定合法）
  function transitionDecl(config: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'a',
      predicate: 'state_transition',
      config: {
        states: ['draft', 'paid', 'done'],
        terminal_states: ['done'],
        from_path: 'from_state',
        to_path: 'to_state',
        ...config,
      },
    };
  }

  it('test_parse_state_transition_rejects_unknown_terminal：terminal 引用越界拒绝', () => {
    const registry = new RuleTypeRegistry();
    expect(() =>
      RuleSet.parse(
        { name: 't', rules: [transitionDecl({ terminal_states: ['finished'] })] },
        registry,
      ),
    ).toThrow(/terminal_states/);
  });

  it('test_parse_state_transition_rejects_unknown_allowed_refs：allowed 引用越界拒绝', () => {
    const registry = new RuleTypeRegistry();
    expect(() =>
      RuleSet.parse(
        { name: 't', rules: [transitionDecl({ allowed: { ghost: ['done'] } })] },
        registry,
      ),
    ).toThrow(/前态/);
    expect(() =>
      RuleSet.parse(
        { name: 't', rules: [transitionDecl({ allowed: { draft: ['ghost'] } })] },
        registry,
      ),
    ).toThrow(/后态/);
    expect(() =>
      RuleSet.parse(
        { name: 't', rules: [transitionDecl({ allowed: ['draft'] })] },
        registry,
      ),
    ).toThrow(/allowed/);
  });

  it('test_parse_state_transition_legal_references_pass：合法引用解析通过且白名单生效', () => {
    const registry = new RuleTypeRegistry();
    const ruleSet = RuleSet.parse(
      {
        name: 't',
        rules: [
          transitionDecl({ allowed: { draft: ['paid', 'done'], paid: ['done'] } }),
        ],
      },
      registry,
    );
    const rule = ruleSet.rules[0]!;
    // 白名单约束真实生效：合法转换通过、白名单外转换判违规
    const ok = new RuleEngine(registry).evaluate(
      new RuleSet({ name: 't', rules: [rule] }),
      { from_state: 'draft', to_state: 'paid' },
    );
    expect(ok.issues).toEqual([]);
    const bad = new RuleEngine(registry).evaluate(
      new RuleSet({ name: 't', rules: [rule] }),
      { from_state: 'paid', to_state: 'draft' },
    );
    expect(bad.issues.length).toBe(1);
  });

  it('test_parse_config_validator_registerable_for_domain_predicates：领域校验器登记', () => {
    const registry = new RuleTypeRegistry();
    registry.register('domain_check', () => []);
    registry.register_config_validator('domain_check', (ruleId, config) => {
      if (config['mode'] !== 'a' && config['mode'] !== 'b') {
        throw new GraphDefinitionError(`规则 ${ruleId} 的 mode 须为 a/b`);
      }
    });
    expect(() =>
      RuleSet.parse(
        {
          name: 't',
          rules: [{ id: 'a', predicate: 'domain_check', config: { mode: 'a' } }],
        },
        registry,
      ),
    ).not.toThrow();
    expect(() =>
      RuleSet.parse(
        {
          name: 't',
          rules: [{ id: 'a', predicate: 'domain_check', config: { mode: 'x' } }],
        },
        registry,
      ),
    ).toThrow(/mode/);
  });
});