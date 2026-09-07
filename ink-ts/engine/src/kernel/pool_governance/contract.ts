/**
 * pool_governance 机制件契约声明（结点池治理：容量/淘汰/合并/预算登记）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——规则判定与登记为纯
 * 函数（判定输入 = 池快照，只登记不执行），治理状态持久化 store 经注入的
 * Storage seam 把判定记录行与去重集合落 records 通道（list_records 读回、
 * put_record 追加，重启恢复防重复判定/重复提请），属 storage_seam 端口面
 * （0-IO：不自持 IO，只经声明端口落簿记）；判定不触模型（近重复余弦为
 * 调用方传入的标量，不列 llm_port），无执行信封（不列 exec_envelope）、
 * 不消费回合组装端口（不列 rounds.port）。
 *
 * depends 为空：pool_governance 不直接依赖任何其它机制件（注册表读为
 * types()/contract_for() 最小读接口，不绑定实现）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../registry/ports.js';

/** pool_governance 机制契约：零机制间依赖，消费 storage_seam 状态簿记端口面。 */
export const pool_governance_contract: MechanismContract = {
  id: 'pool_governance',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: [],
};
