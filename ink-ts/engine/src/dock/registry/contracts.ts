// gate: test-exempt - 机制契约注册表数据（一致性由 contracts.test + verify:mechanisms 守护）
/**
 * 机制契约单一真源聚合（阶段1 verify/装配完整 + boot 密封共用）。
 *
 * 全量机制契约清单（27 项，与各机制层 `<mechanism>/contract.ts`——跨
 * kernel/graph/gate/loop/evolve——一一对应，id = 目录名）。boot 密封
 * （seal_mechanism_registry）与 verify 脚本
 * （依赖单向/装配完整）从此聚合取数，不再在测试/脚本侧各自拼清单——契约
 * 数量/成员变动只改本文件一处（AGENTS「数字先核实 + 工具清单同步」纪律）。
 *
 * 本文件只 re-export 各机制的契约 const（值面 import 无副作用），不新增
 * 机制间依赖边；registry 目录对外仍以 registry/index.ts 为汇出口。
 */

import type { MechanismContract } from './contract_types.js';

import { approval_contract } from '../../gate/approval/contract.js';
import { audit_log_contract } from '../../gate/audit_log/contract.js';
import { budget_contract } from '../../gate/budget/contract.js';
import { evolution_writer_contract } from '../../evolve/proposal/evolution_writer/contract.js';
import { executor_contract } from '../../graph/executor/contract.js';
import { interrupt_contract } from '../../loop/interrupt/contract.js';
import { introspection_contract } from '../../evolve/observe/inspection/contract.js';
import { knowledge_gate_contract } from '../../evolve/learn/knowledge_gate/contract.js';
import { llm_contract } from '../../loop/llm/contract.js';
import { memory_extract_contract } from '../../evolve/learn/memory_extract/contract.js';
import { patch_contract } from '../../gate/patch/contract.js';
import { permissions_contract } from '../../gate/permissions/contract.js';
import { recovery_contract } from '../../loop/recovery/contract.js';
import { round_steps_contract } from '../../loop/round_steps/contract.js';
import { runtime_contract } from '../../loop/runtime/contract.js';
import { sandbox_contract } from '../../gate/sandbox/contract.js';
import { self_application_contract } from '../../evolve/proposal/self_application/contract.js';
import { self_proposal_contract } from '../../evolve/proposal/self_proposal/contract.js';
import { self_tools_contract } from '../../evolve/proposal/self_edit_tools/contract.js';
import { settle_contract } from '../../loop/turn_settle/contract.js';
import { skill_crystal_contract } from '../../evolve/skill/crystallization/contract.js';
import { tool_pipeline_contract } from '../../loop/tools/tool_pipeline/contract.js';
import { tool_vetting_contract } from '../../gate/tool_vetting/contract.js';
import { tuning_contract } from '../../evolve/param_tuning/contract.js';

/** 全量机制契约清单（24 项；id 与目录同集，由 validate 强制唯一）。 */
export const ALL_MECHANISM_CONTRACTS: readonly MechanismContract[] = [
  approval_contract,
  audit_log_contract,
  budget_contract,
  evolution_writer_contract,
  executor_contract,
  interrupt_contract,
  introspection_contract,
  knowledge_gate_contract,
  llm_contract,
  memory_extract_contract,
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
  skill_crystal_contract,
  tool_pipeline_contract,
  tool_vetting_contract,
  tuning_contract,
];
