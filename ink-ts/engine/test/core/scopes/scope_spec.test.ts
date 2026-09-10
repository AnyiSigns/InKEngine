/**
 * 作用域声明块解析/校验单测（scope_spec.ts 数据面）。
 *
 * 覆盖：
 * - 词汇表：出厂目录身份 8 行 + is_factory_scope_role；
 * - 声明块 round-trip（parse ↔ scope_decl_to_dict 全字段保持）；
 * - 各字段校验 fail-closed：capabilities（清单/class 词表）、rules、
 *   cost_tier、contract（shape 词表/绑定字段）、guard_level（审批档词表）；
 * - 未知键忽略（前向兼容）；空/缺省声明解析为空对象。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  CAPABILITY_CLASS_FUNCTION,
  CAPABILITY_CLASS_ORGANIZATION,
  FACTORY_SCOPE_ROLES,
  SCOPE_GUARD_DEFAULT,
  SCOPE_ROLE_COLLABORATOR,
  SCOPE_ROLE_MAIN,
  SCOPE_ROLE_SUBAGENT,
  is_factory_scope_role,
  parse_scope_decl,
  scope_decl_to_dict,
  type ScopeDecl,
} from '../../../src/core/scopes/scope_spec.js';
import { DEFAULT_ENTITY_ROLE } from '../../../src/core/entities/entities.js';

function valid_decl(): ScopeDecl {
  return {
    capabilities: [
      { id: 'delegate', class: CAPABILITY_CLASS_ORGANIZATION },
      { id: 'search', class: CAPABILITY_CLASS_FUNCTION },
    ],
    rules: ['no_cross_scope'],
    cost_tier: 'standard',
    contract: {
      consumes: [{ shape: 'message', key: 'task' }],
      produces: [{ shape: 'field', key: 'plan', schema: { kind: 'text' } }],
    },
    guard_level: 'L1',
  };
}

describe('scope_spec 出厂目录词汇', () => {
  it('出厂目录身份 = 8 行（含协作者/子代理模板）', () => {
    expect(FACTORY_SCOPE_ROLES).toEqual([
      'main',
      'planner',
      'coder',
      'critic',
      'searcher',
      'tester',
      'collaborator',
      'subagent',
    ]);
  });

  it('is_factory_scope_role 命中出厂行、放行宿主自定义、拒绝空', () => {
    expect(is_factory_scope_role(SCOPE_ROLE_MAIN)).toBe(true);
    expect(is_factory_scope_role(SCOPE_ROLE_SUBAGENT)).toBe(true);
    expect(is_factory_scope_role('security_reviewer')).toBe(false);
    expect(is_factory_scope_role('')).toBe(false);
  });

  it('collaborator 与实体目录缺省角色同值（无 import 环下的词汇对齐）', () => {
    expect(SCOPE_ROLE_COLLABORATOR).toBe(DEFAULT_ENTITY_ROLE);
  });
});

describe('scope_spec 声明块 round-trip', () => {
  it('parse ↔ to_dict 全字段保持（含嵌套 schema）', () => {
    const restored = parse_scope_decl(scope_decl_to_dict(valid_decl()));
    expect(restored).toEqual(valid_decl());
  });

  it('空/缺省/None 解析为空对象，序列化不落多余键', () => {
    expect(parse_scope_decl(undefined)).toEqual({});
    expect(parse_scope_decl(null)).toEqual({});
    expect(scope_decl_to_dict({})).toEqual({});
    expect(scope_decl_to_dict({ guard_level: SCOPE_GUARD_DEFAULT })).toEqual({
      guard_level: 'L1',
    });
  });

  it('未知键忽略（前向兼容宿主扩展字段）', () => {
    const parsed = parse_scope_decl({ capabilities: [], future_flag: true });
    expect(parsed).toEqual({});
  });
});

describe('scope_spec 声明块字段校验（fail-closed）', () => {
  it('capabilities 须为 {id,class} 清单，class 词表受限', () => {
    expect(() => parse_scope_decl({ capabilities: 'delegate' })).toThrow(
      /capabilities 非法/,
    );
    expect(() =>
      parse_scope_decl({ capabilities: [{ id: 'x', class: 'mystery' }] }),
    ).toThrow(/class/);
    expect(() =>
      parse_scope_decl({ capabilities: [{ class: CAPABILITY_CLASS_FUNCTION }] }),
    ).toThrow(/id/);
  });

  it('rules 须为非空字符串清单', () => {
    expect(() => parse_scope_decl({ rules: [1] })).toThrow(/rules/);
    expect(() => parse_scope_decl({ rules: [''] })).toThrow(/rules/);
  });

  it('cost_tier 须为字符串', () => {
    expect(() => parse_scope_decl({ cost_tier: 5 })).toThrow(/cost_tier/);
  });

  it('contract 的 shape/绑定字段受限', () => {
    expect(() =>
      parse_scope_decl({ contract: { consumes: [{ shape: 'blob' }] } }),
    ).toThrow(/shape/);
    expect(() =>
      parse_scope_decl({ contract: { produces: 'field' } }),
    ).toThrow(/produces 非法/);
    expect(() =>
      parse_scope_decl({ contract: { consumes: [{ shape: 'field', key: 5 }] } }),
    ).toThrow(/key/);
  });

  it('guard_level 值面绑定 APPROVAL_LEVELS 词表', () => {
    expect(() => parse_scope_decl({ guard_level: 'L9' })).toThrow(/guard_level/);
    for (const level of ['L0', 'L1', 'L2']) {
      expect(parse_scope_decl({ guard_level: level }).guard_level).toBe(level);
    }
  });

  it('非 dict 声明块显式拒绝', () => {
    expect(() => parse_scope_decl('main')).toThrow(GraphDefinitionError);
    expect(() => parse_scope_decl(['x'])).toThrow(/期望 dict/);
  });
});
