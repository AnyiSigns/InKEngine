import { describe, expect, it } from 'vitest';

import { runtime_contract } from '../../../src/kernel/runtime/contract.js';
import {
  ALL_MECHANISM_CONTRACTS,
  MECHANISM_PORT_IDS,
  validate_mechanism_registry,
} from '../../../src/kernel/registry/index.js';

const ALL_CONTRACTS = ALL_MECHANISM_CONTRACTS;

describe('全量机制契约注册表（33 机制）', () => {
  it('契约 id 全局唯一且与目录同集', () => {
    const ids = ALL_CONTRACTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ALL_CONTRACTS.length);
    expect(ALL_CONTRACTS.length).toBe(33);
  });

  it('effects 只引用已登记端口', () => {
    const portSet = new Set(MECHANISM_PORT_IDS);
    for (const c of ALL_CONTRACTS) {
      for (const effect of c.contract.effects) {
        expect(portSet.has(effect), `${c.id} 声明未知端口 ${effect}`).toBe(true);
      }
    }
  });

  it('依赖图无环（executor↔path_assembler 环已拆：executor 经注入 seam 消费组装上下文）', () => {
    const violations = validate_mechanism_registry(ALL_CONTRACTS);
    const cycles = violations.filter((v) => v.rule === 'cycle').map((v) => v.id).sort();
    expect(cycles).toEqual([]);
    const other = violations.filter((v) => v.rule !== 'cycle');
    expect(other).toEqual([]);
  });

  it('runtime 聚合全部机制为装配闭集（含 executor/path_assembler 的环内机制）', () => {
    const byId = new Map(ALL_CONTRACTS.map((c) => [c.id, c]));
    for (const dep of runtime_contract.depends) {
      expect(byId.has(dep), `runtime 依赖 ${dep} 无契约`).toBe(true);
    }
  });
});
