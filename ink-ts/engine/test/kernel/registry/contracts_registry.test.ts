import { describe, expect, it } from 'vitest';

import { audit_log_contract } from '../../../src/kernel/audit_log/contract.js';
import { approval_contract } from '../../../src/kernel/approval/contract.js';
import { budget_contract } from '../../../src/kernel/budget/contract.js';
import { builder_contract } from '../../../src/kernel/builder/contract.js';
import { entity_evolution_contract } from '../../../src/kernel/entity_evolution/contract.js';
import { evolution_writer_contract } from '../../../src/kernel/evolution_writer/contract.js';
import { evolution_contract } from '../../../src/kernel/evolution/contract.js';
import { executor_contract } from '../../../src/kernel/executor/contract.js';
import { growth_contract } from '../../../src/kernel/growth/contract.js';
import { interrupt_contract } from '../../../src/kernel/interrupt/contract.js';
import { introspection_contract } from '../../../src/kernel/introspection/contract.js';
import { knowledge_gate_contract } from '../../../src/kernel/knowledge_gate/contract.js';
import { llm_contract } from '../../../src/kernel/llm/contract.js';
import { memory_extract_contract } from '../../../src/kernel/memory_extract/contract.js';
import { multipath_contract } from '../../../src/kernel/multipath/contract.js';
import { patch_contract } from '../../../src/kernel/patch/contract.js';
import { path_assembler_contract } from '../../../src/kernel/path_assembler/contract.js';
import { permissions_contract } from '../../../src/kernel/permissions/contract.js';
import { pool_governance_contract } from '../../../src/kernel/pool_governance/contract.js';
import { recovery_contract } from '../../../src/kernel/recovery/contract.js';
import { round_steps_contract } from '../../../src/kernel/round_steps/contract.js';
import { runtime_contract } from '../../../src/kernel/runtime/contract.js';
import { sandbox_contract } from '../../../src/kernel/sandbox/contract.js';
import { self_application_contract } from '../../../src/kernel/self_application/contract.js';
import { self_proposal_contract } from '../../../src/kernel/self_proposal/contract.js';
import { self_tools_contract } from '../../../src/kernel/self_tools/contract.js';
import { settle_contract } from '../../../src/kernel/settle/contract.js';
import { simulation_contract } from '../../../src/kernel/simulation/contract.js';
import { skill_crystal_contract } from '../../../src/kernel/skill_crystal/contract.js';
import { spawn_contract } from '../../../src/kernel/spawn/contract.js';
import { tool_pipeline_contract } from '../../../src/kernel/tool_pipeline/contract.js';
import { tool_vetting_contract } from '../../../src/kernel/tool_vetting/contract.js';
import { tuning_contract } from '../../../src/kernel/tuning/contract.js';
import {
  MECHANISM_PORT_IDS,
  validate_mechanism_registry,
} from '../../../src/kernel/registry/index.js';
import type { MechanismContract } from '../../../src/kernel/registry/index.js';

const ALL_CONTRACTS: readonly MechanismContract[] = [
  approval_contract,
  audit_log_contract,
  budget_contract,
  builder_contract,
  entity_evolution_contract,
  evolution_writer_contract,
  evolution_contract,
  executor_contract,
  growth_contract,
  interrupt_contract,
  introspection_contract,
  knowledge_gate_contract,
  llm_contract,
  memory_extract_contract,
  multipath_contract,
  patch_contract,
  path_assembler_contract,
  permissions_contract,
  pool_governance_contract,
  recovery_contract,
  round_steps_contract,
  runtime_contract,
  sandbox_contract,
  self_application_contract,
  self_proposal_contract,
  self_tools_contract,
  settle_contract,
  simulation_contract,
  skill_crystal_contract,
  spawn_contract,
  tool_pipeline_contract,
  tool_vetting_contract,
  tuning_contract,
];

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
