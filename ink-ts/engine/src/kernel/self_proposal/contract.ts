/**
 * self_proposal 机制件契约声明：自指层提案协议（补丁类型声明 + 数据形态）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——self_proposal 只
 * 负责「把变更意图整理为可校验的声明式补丁」：PatchKind 值集合与数据面
 * generated PATCH_KINDS 编译期双向绑定，ProposalValidator 按补丁类型复用
 * 引擎既有校验器（ui_schema / declarative_tools / rules / knowledge_set /
 * harness / event_types / environments / entities），为构造即校验的纯函数
 * 判定；应用/审批/落链/回退在应用管线面，本机制不消费审批挂起、存储、
 * 模型与执行端口。0-IO：不自持 IO。
 *
 * depends 为空：self_proposal 不直接依赖任何其它机制件（校验器只依赖
 * core 既有构造面与同目录数据面）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** self_proposal 机制契约：零机制间依赖，零副作用端口（提案协议数据面）。 */
export const self_proposal_contract: MechanismContract = {
  id: 'self_proposal',
  contract: {
    effects: [],
  },
  depends: [],
};
