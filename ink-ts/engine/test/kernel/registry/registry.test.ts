import { describe, expect, it } from 'vitest';

import { PORT_STORAGE_SEAM } from '../../../src/dock/ports.js';
import { audit_log_contract } from '../../../src/kernel/audit_log/contract.js';
import {
  seal_mechanism_registry,
  topo_order,
  validate_mechanism_registry,
} from '../../../src/kernel/registry/index.js';
import type { MechanismContract } from '../../../src/kernel/registry/index.js';

describe('机制件注册表密封', () => {
  it('audit_log 样板契约通过校验并进装配序', () => {
    const violations = validate_mechanism_registry([audit_log_contract]);
    expect(violations).toEqual([]);
    const sealed = seal_mechanism_registry([audit_log_contract]);
    expect(sealed.contracts.get('audit_log')).toBe(audit_log_contract);
    expect(sealed.order).toEqual(['audit_log']);
    expect(audit_log_contract.contract.effects).toContain(PORT_STORAGE_SEAM);
    expect(audit_log_contract.depends).toEqual([]);
  });

  it('重复 id 拒绝', () => {
    const dup: MechanismContract = {
      id: 'audit_log',
      contract: { effects: [PORT_STORAGE_SEAM] },
      depends: [],
    };
    const violations = validate_mechanism_registry([audit_log_contract, dup]);
    expect(violations.some((v) => v.rule === 'duplicate-id')).toBe(true);
  });

  it('未知依赖拒绝（外部名单放行除外）', () => {
    const a: MechanismContract = { id: 'a', contract: { effects: [] }, depends: [] };
    const b: MechanismContract = { id: 'b', contract: { effects: [] }, depends: ['ghost'] };
    expect(validate_mechanism_registry([a, b]).some((v) => v.rule === 'unknown-dep')).toBe(true);
    const c: MechanismContract = { id: 'c', contract: { effects: [] }, depends: ['rounds.port'] };
    expect(validate_mechanism_registry([a, c], ['rounds.port'])).toEqual([]);
  });

  it('自环依赖拒绝', () => {
    const a: MechanismContract = { id: 'a', contract: { effects: [] }, depends: ['a'] };
    expect(validate_mechanism_registry([a]).some((v) => v.rule === 'self-dep')).toBe(true);
  });

  it('循环依赖拒绝（fail-closed）', () => {
    const a: MechanismContract = { id: 'a', contract: { effects: [] }, depends: ['b'] };
    const b: MechanismContract = { id: 'b', contract: { effects: [] }, depends: ['a'] };
    const violations = validate_mechanism_registry([a, b]);
    expect(violations.some((v) => v.rule === 'cycle')).toBe(true);
    expect(() => seal_mechanism_registry([a, b])).toThrow(/循环依赖|密封失败/);
  });

  it('装配序 = 被依赖者先（拓扑序）', () => {
    const base: MechanismContract = { id: 'base', contract: { effects: [] }, depends: [] };
    const mid: MechanismContract = { id: 'mid', contract: { effects: [] }, depends: ['base'] };
    const top: MechanismContract = { id: 'top', contract: { effects: [] }, depends: ['mid'] };
    expect(topo_order([top, base, mid])).toEqual(['base', 'mid', 'top']);
    expect(seal_mechanism_registry([top, base, mid]).order).toEqual(['base', 'mid', 'top']);
  });
});
