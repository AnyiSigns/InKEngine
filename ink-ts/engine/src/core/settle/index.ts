/**
 * 沉淀域公开 re-export（snake_case 镜像 Python settle.__all__）。
 *
 * 文件拆分纪律（settle.py 按结构拆分）：
 * - 常量与失败分类归 _constants.ts；时间 seam 归 _time.ts；
 * - 数据形态（TraceStep/Traversal/EdgeUpdate/SettleContext）与主键编码
 *   归 types.ts；
 * - 轨迹回放/归因方向/归因计划归 attribution.ts；
 * - 提案/晋升/复审判据与契约草案纯函数归 rules.ts；
 * - 归因/审计/注册体钩子归 hooks.ts；指纹缓存钩子归 fingerprint.ts；
 *   失败点提案钩子归 proposal.ts；推荐先验晋升钩子归 promotion.ts；
 *   策略边复审/池治理钩子归 review.ts；种子导入归 seed.ts。
 */

export {
  DEFAULT_DOMAIN,
  POLICY_REVIEW_DOMAIN_MIN_EDGES,
  POLICY_REVIEW_FAIL_THRESHOLD,
  PROMOTION_MIN_N,
  PROMOTION_MIN_P,
  PROPOSAL_FAIL_RATE,
  PROPOSAL_MIN_FAILS,
  PROPOSAL_RATE_MIN_N,
  TRACE_FAILED,
  TRACE_SKIPPED,
  TRACE_SUCCESS,
  UPDATE_FAIL,
  UPDATE_SUCCESS,
} from './_constants.js';

export {
  EdgeEvidenceSettleHook,
  FailureAuditSettleHook,
  SettleHooks,
} from './hooks.js';
export type { AuditSink, SettleHook } from './hooks.js';

export { FingerprintSettleHook } from './fingerprint.js';
export type {
  ContextFingerprint,
  FingerprintCache,
  FingerprintCacheUpsertOpts,
  GateLike,
  QualityGate,
} from './fingerprint.js';

export { NodeProposalSettleHook } from './proposal.js';
export type { ProposalSink } from './proposal.js';

export { RecommendedPriorSettleHook, promotion_signature_key } from './promotion.js';
export type { OnPromoted, PromotionGate, PromotionSink, PromotionSignature } from './promotion.js';

export {
  PolicyEdgeReviewSettleHook,
  PoolGovernanceSettleHook,
} from './review.js';
export type { ReviewSink } from './review.js';

export { import_seed_paths } from './seed.js';

export {
  EdgeUpdate,
  SettleContext,
  TraceStep,
  Traversal,
  edge_key_str,
  node_identity,
  path_key,
  token_key,
  traversal_edge_key,
} from './types.js';
export type { SettleContextInit } from './types.js';

export { attribution_plan, derive_traversals, run_verdict } from './attribution.js';

export {
  classify_failure,
  draft_node_contract,
  policy_edge_needs_review,
  recommended_prior_eligible,
  should_propose,
} from './rules.js';

export { now, set_now } from './_time.js';
