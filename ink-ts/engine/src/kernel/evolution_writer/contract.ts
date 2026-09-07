/**
 * evolution_writer 机制件契约声明（演化资产统一写入协议）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——evolution_writer 经
 * 注入的存储 seam 完成三重闸门：补丁链 append 与实时数据写直接调用注入
 * 存储对象（EvolutionStorage duck 形态；受守卫存储走 allow_mechanism
 * 豁免上下文），审计留痕经 audit_log 的 emit_audit 落 set_audit——属
 * storage_seam 端口面（0-IO：不自持 IO，只调声明端口）。
 *
 * depends：evolution_writer 组合 audit_log（emit_audit 审计留痕）与 patch
 * （内容型 PatchChain 落补丁链）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../registry/ports.js';

/** 演化写入机制契约：依赖 audit_log/patch，消费 storage_seam 落库端口面。 */
export const evolution_writer_contract: MechanismContract = {
  id: 'evolution_writer',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: ['audit_log', 'patch'],
};
