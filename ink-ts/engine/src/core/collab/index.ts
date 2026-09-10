/**
 * 协作数据面子模块公共面（纯 re-export，不实现）。
 *
 * 主引擎公共面（src/index.ts）的 re-export 由主控统一接线（本批 6C1 独占
 * core/collab，不动 index.ts）；分组：
 * - 文本规范化（normalize_opinion_text / texts_related）；
 * - 意见块与输入契约门禁（OpinionEntry / parse_opinion_entry / validate_opinion_schema）；
 * - 裁决四步（adjudicate / dedupe / 冲突检测 / 仲裁 / 综合输入）；
 * - 圆桌收敛判据（opinions_digest / confirmers / judge_round）。
 */

export { normalize_opinion_text, texts_related } from './normalize.js';

export {
  opinion_payload,
  parse_opinion_entry,
  validate_opinion_schema,
} from './opinion.js';
export type { OpinionEntry, ParsedOpinion, RejectedOpinion } from './opinion.js';

export {
  ARBITRATION_PRIOR,
  ARBITRATION_PRIORITY,
  ARBITRATION_QUALITY,
  ARBITRATION_USER,
  OPPOSE_MARKERS,
  USER_SCOPE,
  adjudicate,
  arbitrate_conflict,
  build_synthesis,
  dedupe_opinions,
  detect_conflicts,
  explicit_value,
  is_oppose_marked,
} from './adjudication.js';
export type {
  AdjudicationOptions,
  AdjudicationResult,
  ArbitrationBasis,
  ArbitrationOptions,
  ArbitrationPriority,
  ConflictPair,
  ConflictSuggestion,
  DedupeGroup,
  SynthesisConflict,
  SynthesisInput,
  SynthesisPoint,
} from './adjudication.js';

export {
  CONFIRM_MARKERS,
  DEFAULT_CONFIRM_K,
  DEFAULT_ROUNDS_CAP,
  confirmers,
  judge_round,
  opinions_digest,
} from './convergence.js';
export type { ConvergenceConfig, ConvergenceReason, ConvergenceVerdict } from './convergence.js';
