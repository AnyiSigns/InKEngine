/**
 * 自指层应用管线公开面（core/self_application.py __all__ 镜像）。
 *
 * 应用 = 提案落地的唯一路径：校验（ProposalValidator）→ 基准冲突检测
 * → 审批分级（L0 策略直过 / L1 弹卡 / L2 沙箱验证 + 人工）→ 补丁链
 * append → 审计留痕 → 活跃态应用（ApplyTarget 钩子）。回退 = 链级操作
 * （仅允许回退链尾补丁）。旁路写防护（GuardedStorage）：集内可演化资产
 * 集合的唯一写入路径 = 本管线，未携带补丁链上下文的直写被拒绝。
 *
 * 实现拆分为常量/分级/落点推导/链/结果/策略/管线/防护多文件
 * （≤350 行纪律；apply/revert 机制函数类级拆分见 pipeline + apply_flow/
 * revert_flow）。
 */

export {
  APPROVAL_TIMEOUT_SECONDS,
  ApprovalLevel,
  DEFAULT_APPROVAL_LEVELS,
} from './approval_level.js';
export type { L2VettingHook } from './approval_level.js';

export {
  AUDIT_STATUS_APPLIED,
  AUDIT_STATUS_CONFLICT,
  AUDIT_STATUS_INVALID,
  AUDIT_STATUS_REJECTED,
  AUDIT_STATUS_REVERTED,
  AUDIT_STATUS_REVERTED_NOTIFY_FAILED,
  SEGMENT_TO_KIND,
  SET_AUDIT_COLLECTION,
} from './constants.js';

export { GuardedStorage } from './guarded_storage.js';
export type { GuardedStorageInit, MechanismExemptionScope } from './guarded_storage.js';

export { PatchOutcome } from './patch_outcome.js';
export type { ApplyTarget, PatchOutcomeInit } from './patch_outcome.js';

export { patch_path } from './patch_path.js';

export { SelfApplicationPipeline } from './pipeline.js';
export type {
  ApplyOptions,
  OnRevertedHook,
  RegressionHook,
  RevertOptions,
  SelfApplicationPipelineInit,
} from './pipeline.js';

export { SetPatchChain } from './set_patch_chain.js';
export type { SetPatchChainInit } from './set_patch_chain.js';
