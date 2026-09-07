/**
 * runtime 机制件契约声明。
 *
 * runtime = 引擎装配/生命周期壳：宿主按 Host 五件套（存储工厂/模型解析/审批
 * 策略/事件传输工厂/关停钩子）与 AssemblyRecipe 装配数据把引擎交予运行时，
 * boot/pause/resume/stop 驱动生命周期；每轮回合按数据组装出本轮图再新建引擎
 * 执行。runtime 处于编排位——把其余机制的装配产物逐一注入引擎（注册表/校验
 * 器/自指管线/统一工具分发/沉淀钩子/自学习族等），自身是装配动作的属主而不
 * 被机制注入；装配动作归机制层，不可被补丁链改写。
 *
 * effects 判定（只列 runtime 自身 src 真实消费的端口面，宁缺勿滥）：
 * - storage_seam：_runtime_assemble 经 host.create_storage() 取原始存储后包
 *   GuardedStorage（受守卫写通道），知识集/注册表/实体/事件类型/池治理等装配
 *   与回合落库全走该 seam；
 * - llm_port：_runtime_engine 经 host.resolve_llm() 取 AsyncLLM 并包
 *   UsageTrackingLLM/CompressingLLM 守卫链后装配进回合引擎；
 * - exec_envelope 不列：runtime 不直接消费进程/文件沙箱 seam（runtime src 无
 *   子进程/沙箱调用，执行面经 executor 机制拿引擎，信封归 executor/harness
 *   侧）；
 * - rounds.port 不列：assemble_round/resume_run/resume_round/abort 由 runtime
 *   自身实现，runtime 是该端口的提供方（引擎导出端口语义，供其它机制/插件
 *   依赖），而非消费者——提供面不入本契约 effects 白名单。
 *
 * depends = 装配闭集所需机制件清单：runtime 各 _runtime_*.ts 以 value import
 * 引用的全部内核机制并集（round_steps 仅 type import，不构成装配期 value
 * 依赖，故不入列）。契约化归属见 engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_LLM_PORT, PORT_STORAGE_SEAM } from '../registry/ports.js';

/** runtime 机制契约：引擎装配/生命周期壳，编排其余机制；消费存储与模型 seam。 */
export const runtime_contract: MechanismContract = {
  id: 'runtime',
  contract: {
    effects: [PORT_STORAGE_SEAM, PORT_LLM_PORT],
  },
  depends: [
    'approval',
    'audit_log',
    'entity_evolution',
    'evolution',
    'evolution_writer',
    'executor',
    'growth',
    'introspection',
    'llm',
    'memory_extract',
    'path_assembler',
    'permissions',
    'pool_governance',
    'self_application',
    'self_proposal',
    'self_tools',
    'settle',
    'skill_crystal',
    'tool_pipeline',
    'tool_vetting',
    'tuning',
  ],
};
