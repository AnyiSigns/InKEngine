import { describe, expect, it } from 'vitest';

import { runtime_contract } from '../../../src/kernel/runtime/contract.js';
import {
  ALL_MECHANISM_CONTRACTS,
  MECHANISM_PORT_IDS,
  validate_mechanism_registry,
} from '../../../src/kernel/registry/index.js';

const ALL_CONTRACTS = ALL_MECHANISM_CONTRACTS;

describe('全量机制契约注册表（31 机制；path_assembler/pool_governance/thread_skeleton 契约随组装链路退役，W7-B）', () => {
  it('契约 id 全局唯一且与目录同集', () => {
    const ids = ALL_CONTRACTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ALL_CONTRACTS.length);
    expect(ALL_CONTRACTS.length).toBe(31);
  });

  it('effects 只引用已登记端口', () => {
    const portSet = new Set(MECHANISM_PORT_IDS);
    for (const c of ALL_CONTRACTS) {
      for (const effect of c.contract.effects) {
        expect(portSet.has(effect), `${c.id} 声明未知端口 ${effect}`).toBe(true);
      }
    }
  });

  it('依赖图无环（组装时代 executor↔path_assembler 环随机制退役消失）', () => {
    const violations = validate_mechanism_registry(ALL_CONTRACTS);
    const cycles = violations.filter((v) => v.rule === 'cycle').map((v) => v.id).sort();
    expect(cycles).toEqual([]);
    const other = violations.filter((v) => v.rule !== 'cycle');
    expect(other).toEqual([]);
  });

  it('runtime 聚合全部机制为装配闭集（含 executor 等装配机制）', () => {
    const byId = new Map(ALL_CONTRACTS.map((c) => [c.id, c]));
    for (const dep of runtime_contract.depends) {
      expect(byId.has(dep), `runtime 依赖 ${dep} 无契约`).toBe(true);
    }
  });
});
