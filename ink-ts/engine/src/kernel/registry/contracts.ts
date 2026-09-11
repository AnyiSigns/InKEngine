/**
 * 机制契约单一真源聚合（阶段1 verify/装配完整 + boot 密封共用）。
 *
 * 全量机制契约清单（31 项，与 engine/src/kernel/<mechanism>/contract.ts 一一
 * 对应，id = 目录名）。boot 密封（seal_mechanism_registry）与 verify 脚本
 * （依赖单向/装配完整）从此聚合取数，不再在测试/脚本侧各自拼清单——契约
 * 数量/成员变动只改本文件一处（AGENTS「数字先核实 + 工具清单同步」纪律）。
 *
 * 本文件只 re-export 各机制的契约 const（值面 import 无副作用），不新增
 * 机制间依赖边；registry 目录对外仍以 registry/index.ts 为汇出口。
 */

import type { MechanismContract } from './contract_types.js';

import { approval_contract } from '../approval/contract.js';
import { audit_log_contract } from '../audit_log/contract.js';
import { budget_contract } from '../budget/contract.js';
import { builder_contract } from '../builder/contract.js';
import { entity_evolution_contract } from '../entity_evolution/contract.js';
import { evolution_contract } from '../evolution/contract.js';
import { evolution_writer_contract } from '../evolution_writer/contract.js';
import { executor_contract } from '../executor/contract.js';
import { growth_contract } from '../growth/contract.js';
import { interrupt_contract } from '../interrupt/contract.js';
import { introspection_contract } from '../introspection/contract.js';
import { knowledge_gate_contract } from '../knowledge_gate/contract.js';
import { llm_contract } from '../llm/contract.js';
import { memory_extract_contract } from '../memory_extract/contract.js';
import { multipath_contract } from '../multipath/contract.js';
import { patch_contract } from '../patch/contract.js';
import { permissions_contract } from '../permissions/contract.js';
import { recovery_contract } from '../recovery/contract.js';
import { round_steps_contract } from '../round_steps/contract.js';
import { runtime_contract } from '../runtime/contract.js';
import { sandbox_contract } from '../sandbox/contract.js';
import { self_application_contract } from '../self_application/contract.js';
import { self_proposal_contract } from '../self_proposal/contract.js';
import { self_tools_contract } from '../self_tools/contract.js';
import { settle_contract } from '../settle/contract.js';
import { simulation_contract } from '../simulation/contract.js';
import { skill_crystal_contract } from '../skill_crystal/contract.js';
import { spawn_contract } from '../spawn/contract.js';
import { tool_pipeline_contract } from '../tool_pipeline/contract.js';
import { tool_vetting_contract } from '../tool_vetting/contract.js';
import { tuning_contract } from '../tuning/contract.js';

/** 全量机制契约清单（31 项；id 与目录同集，由 validate 强制唯一）。 */
export const ALL_MECHANISM_CONTRACTS: readonly MechanismContract[] = [
  approval_contract,
  audit_log_contract,
  budget_contract,
  builder_contract,
  entity_evolution_contract,
  evolution_contract,
  evolution_writer_contract,
  executor_contract,
  growth_contract,
  interrupt_contract,
  introspection_contract,
  knowledge_gate_contract,
  llm_contract,
  memory_extract_contract,
  multipath_contract,
  patch_contract,
  permissions_contract,
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
