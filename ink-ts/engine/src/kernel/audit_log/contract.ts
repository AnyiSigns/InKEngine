/**
 * audit_log 机制件契约声明（样板：最小机制，零机制间依赖）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——audit_log 经注入的
 * AuditStorage seam 落审计记录，属 storage_seam 端口面（0-IO：不自持 IO，
 * 只调声明端口）。contract.inputs/outputs 声明期不固化（审计记录宽松 dict，
 * 形状随调用点透传）。
 *
 * depends 为空：audit_log 不直接依赖任何其它机制件（emit_audit 以参数注入
 * 存储 seam；端口 id 词汇见 ../../dock/ports.ts）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../../dock/ports.js';

/** audit_log 机制契约：零机制间依赖，消费 storage_seam 审计落库端口面。 */
export const audit_log_contract: MechanismContract = {
  id: 'audit_log',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: [],
};
