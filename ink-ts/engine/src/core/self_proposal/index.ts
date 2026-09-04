/**
 * 自指层提案协议公开面（core/self_proposal.py __all__ 镜像）。
 *
 * 提案 = AI 修改产品形态的唯一入口形态（观察之后、应用之前）：先把变更
 * 意图整理为声明式补丁（类型 + payload + 基准版本 + 理由），经按类型校验
 * 确认形态合法，再交应用管线走审批分级与落链（应用/审批/回退在
 * self_application）。本模块只负责「把提案整理成可校验的数据」。
 *
 * 实现拆分为数据/校验两层文件（≤350 行纪律）：
 * - self_proposal：PatchKind（补丁类型枚举）/ SelfProposal（提案数据形态）
 *   / 合法形态示例骨架；
 * - proposal_validator：ProposalValidator（按类型校验 payload，违规清单
 *   可读可审计，每类复用引擎既有校验器，零业务依赖）。
 */
export { PatchKind, SelfProposal } from './self_proposal.js';
export type { PatchKind as PatchKindType, SelfProposalInit } from './self_proposal.js';
export { ProposalValidator } from './proposal_validator.js';
export type { ProposalValidatorInit } from './proposal_validator.js';
