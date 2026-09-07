/**
 * memory_extract 机制件契约声明（回合记忆无感抽取 + 冲突消解）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——抽取与仲裁为纯规则
 * 函数（规则抽取优先，零 LLM），回合收尾 settle 钩子把当轮账本事实经装配
 * 注入的记忆存储对象落位（受控演化通道承接写盘，本机制 src 不直接持有
 * Storage 类 seam 对象，storage_seam 不列）；无模型调用（不列 llm_port）、
 * 无执行信封（不列 exec_envelope）、不消费回合组装端口（不列 rounds.port）。
 * 0-IO：不自持 IO。
 *
 * depends 为空：memory_extract 不直接依赖任何其它机制件（抽取输入 = 账本
 * 宽松读取面，SettleContext 仅 type import）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** memory_extract 机制契约：零机制间依赖，effects 为空（规则抽取 + 注入记忆存储）。 */
export const memory_extract_contract: MechanismContract = {
  id: 'memory_extract',
  contract: {
    effects: [],
  },
  depends: [],
};
