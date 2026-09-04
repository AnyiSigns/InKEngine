/**
 * 边证据与评分类型（对标 ink_engine.core.edge_evidence）。
 *
 * 类型层只承载数据形态：EdgeKey / EdgeEvidence / EdgeScore 三件套与各档位
 * 枚举常量、origin 标识。tier 推导式与零 IO 评分算法见 tier_model.ts；持久化
 * 见 store.ts（注入 seam 而非自带 IO）。
 *
 * 契约版本入键：src/dst 契约版本与 context_domain、variant_hash 共同入键，
 * 升版/换变体后旧行自然不命中（新冷启动），无需任何重置逻辑。
 */

/** 缺省契约版本（结点契约未声明版本时沿用此值入键）。 */
export const DEFAULT_CONTRACT_VERSION = '1';

/** 信任档（观察/常规/转正）——纯算法自动晋级，零审批。 */
export const TIER_OBSERVING = 'observing';
export const TIER_REGULAR = 'regular';
export const TIER_PROMOTED = 'promoted';

/** τ 档位（评分乘数；与推荐先验晋升同源）。 */
export const TIER_TAU: { readonly [tier: string]: number } = {
  [TIER_OBSERVING]: 0.6,
  [TIER_REGULAR]: 0.8,
  [TIER_PROMOTED]: 1.0,
};

/** 证据来源（先验隔离：seed 降权、policy 豁免、runtime 全权）。 */
export const ORIGIN_SEED = 'seed';
export const ORIGIN_RUNTIME = 'runtime';
export const ORIGIN_POLICY = 'policy';

/** 信任档推导阈值（与推荐先验晋升同一组常数；纯算法自动晋级零审批）。 */
export const TIER_REGULAR_N = 8;
export const TIER_REGULAR_P = 0.7;
export const TIER_PROMOTE_N = 30;
export const TIER_PROMOTE_P = 0.9;

/** 评分公式默认常数（引擎钉死；使用方仅覆盖权——数据驱动注入见 tier_model）。 */
export const SATURATION_N = 8.0;
export const DECAY_HALF_DAYS = 30.0;
export const ZERO_EVIDENCE_WEIGHT = 1 / 9;
export const ZERO_EVIDENCE_P = 0.5;
export const ZERO_EVIDENCE_TAU = TIER_TAU[TIER_OBSERVING]!;
export const SEED_WEIGHT = 0.5;

/** 多径触发判据常数（与评分公式同源派生）。 */
export const MULTIPATH_MIN_N = 5;
export const MULTIPATH_GAP = 0.15;

/** 冷启动探索模式阈值。 */
export const EXPLORATION_INDEX_THRESHOLD = 0.3;

/** 信任档降级快照集合（落受控通道；反向复原据此回写原档）。 */
export const EDGE_TIER_OVERRIDE_COLLECTION = 'edge_tier_overrides';

/** 边主键：源结点类型 → 目标结点类型 + 契约版本 + 域 + 可选变体指纹。 */
export interface EdgeKey {
  src_type: string;
  dst_type: string;
  src_contract_version: string;
  dst_contract_version: string;
  context_domain: string;
  variant_hash: string;
}

/** 边证据行（按域聚合的统计事实；派生数据可重建可顶替）。 */
export interface EdgeEvidence {
  key: EdgeKey;
  success_count: number;
  fail_count: number;
  avg_cost: number;
  policy: boolean;
  origin: string;
  last_used_at: number | null;
  created_at: number;
}

/** 评分分量展开（score 为最终评分；分量可断言单调性）。 */
export interface EdgeScore {
  score: number;
  p: number;
  weight: number;
  decay: number;
  tau: number;
  tier: string;
}