/**
 * self_application 机制件契约声明：自指补丁应用管线（提案 → 校验 → 分级审批
 * → 落链 → 活跃态应用 → 审计；另含链尾回退）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——补丁链写入与审计记录
 * 落库都经注入的 Storage seam：GuardedStorage 是集内可演化资产的旁路写防护
 * 包装（直写/整集删除拦截，守卫令牌与豁免上下文放行机制侧自身写入），链写入
 * （SetPatchChain.append）与审计记录（_audit 落 set_audit 集合）均落同一注入
 * 存储面，属 storage_seam 端口面（0-IO：不自持 IO）。分级审批的挂起语义走
 * approval 机制值面（approve_before_execute 注入策略）；L2 沙箱验证/域内回归/
 * 活跃态应用为宿主注入钩子（函数回调），不属 exec_envelope 进程/文件沙箱
 * seam；机制 src 无模型调用（不列 llm_port）、无回合端口消费（不列
 * rounds.port）。
 *
 * depends = 值面机制清单：approval（审批动作/挂起协议）、patch（补丁链模型
 * PatchChain/Patch）、self_proposal（提案协议；校验器类型同属 self_proposal
 * 契约面，其实例由装配层注入——机制不自造默认）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_STORAGE_SEAM } from '../../dock/ports.js';

/** self_application 机制契约：消费 storage_seam 守卫写通道，值依赖审批/补丁链/提案。 */
export const self_application_contract: MechanismContract = {
  id: 'self_application',
  contract: {
    effects: [PORT_STORAGE_SEAM],
  },
  depends: ['approval', 'patch', 'self_proposal'],
};
