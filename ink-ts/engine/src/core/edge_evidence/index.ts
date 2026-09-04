/**
 * 边证据域公开 re-export（snake_case 镜像 Python __all__）。
 *
 * 文件拆分纪律：EdgeKey / EdgeEvidence / EdgeScore 与档位常量落 _types；
 * 评分/档位公式落 tier_model；多径/冷启动落 derived；存储落 store；
 * 干预（downgrade/restore）落 intervention；种子导入落 seed。
 */

export {
  DECAY_HALF_DAYS,
  DEFAULT_CONTRACT_VERSION,
  EDGE_TIER_OVERRIDE_COLLECTION,
  EXPLORATION_INDEX_THRESHOLD,
  MULTIPATH_GAP,
  MULTIPATH_MIN_N,
  ORIGIN_POLICY,
  ORIGIN_RUNTIME,
  ORIGIN_SEED,
  SATURATION_N,
  SEED_WEIGHT,
  TIER_OBSERVING,
  TIER_PROMOTED,
  TIER_PROMOTE_N,
  TIER_PROMOTE_P,
  TIER_REGULAR,
  TIER_REGULAR_N,
  TIER_REGULAR_P,
  TIER_TAU,
  ZERO_EVIDENCE_P,
  ZERO_EVIDENCE_TAU,
  ZERO_EVIDENCE_WEIGHT,
} from './_types.js';

export type { EdgeEvidence, EdgeKey, EdgeScore } from './_types.js';

export {
  derive_edge_tier,
  edge_score,
  get_decay_half_days,
  get_saturation_n,
  get_seed_weight,
  laplace_success,
  sample_weight,
  set_decay_half_days,
  set_saturation_n,
  set_seed_weight,
  tier_tau,
  time_decay,
  zero_evidence_score,
} from './tier_model.js';

export {
  cold_start_index,
  is_exploration_mode,
  multi_path_trigger,
} from './derived.js';

export {
  EdgeEvidenceStore,
  InMemoryEdgeEvidenceStorage,
  edge_evidence_from_dict,
  edge_evidence_to_dict,
  edge_key_from_dict,
  edge_key_to_dict,
} from './store.js';
export type { EdgeEvidenceStorage, EdgeKeyTuple } from './storage_seam.js';

export { downgrade_edge_tier, restore_edge_tier } from './intervention.js';
export type { DowngradeResult, RestoreResult } from './intervention.js';

export { import_seed_paths } from './seed.js';
export type { SeedEdgeRaw } from './seed.js';