/**
 * settle 机制件契约声明（回合沉淀钩子族：归因/证据/指纹/提案/晋升/复审）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——沉淀钩子把引擎回合
 * 簿记经注入的存储对象落 records 通道：边证据归因/降级读改写
 * （EdgeEvidenceStore 注入面，边证据行读写），治理判定行与去重集合随
 * 池治理状态 store 持久化，指纹缓存 upsert 走缓存存储——属 storage_seam
 * 端口面（0-IO：不自持 IO，只经声明存储面读写记录）；判据（归类/是否可
 * 提/复审/晋升资格）为纯规则，零 LLM（不列 llm_port），无执行信封（不列
 * exec_envelope）、不消费回合组装端口（不列 rounds.port；settle 是回合
 * 收尾的被触发方，入向钩子不构成端口消费）。
 *
 * depends：settle 组合 pool_governance（池治理登记器/快照/周预算口径，
 * 见 review.ts 池治理钩子真实现）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../registry/ports.js';

/** settle 机制契约：依赖 pool_governance，消费 storage_seam 沉淀簿记端口面。 */
export const settle_contract: MechanismContract = {
  id: 'settle',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: ['pool_governance'],
};
