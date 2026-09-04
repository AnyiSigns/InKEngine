/**
 * 指纹缓存条目结构与机制常数（镜像 Python ink_engine.core.fingerprint_cache）。
 *
 * 缓存条目 = {上下文指纹(主键), 路径图定义序列化, 路径图指纹, 证据快照,
 * 契约版本快照, 模型 id, 时间戳, 命中数, 失败数, 域}。派生数据由运行历史
 * 可重建；契约版本 + 模型 id 钉死（变化 = 降级不命中）。类型即数据，
 * 序列化经注入存储 seam 落库（core 零 IO）。
 */

/** 每域容量上限（达上限按「命中率 + 时效」淘汰最差条目）。 */
export const DEFAULT_CACHE_CAP_PER_DOMAIN = 1000;

/** 证据漂移判据常数：相对差 ≥ 0.2（且样本 N ≥ 5 才判漂移，防小样本噪声）。 */
export const DRIFT_RATIO = 0.2;
export const DRIFT_MIN_N = 5;

/** 顶替原因（声明式枚举，防魔法字符串）。 */
export const REPLACE_REASON_DRIFT = '证据漂移';
export const REPLACE_REASON_SAMPLE = '抽样重装';

/** 一条缓存条目（主键 = 上下文指纹；与沉淀侧 upsert 键一致）。 */
export type FingerprintCacheEntry = {
  /** 上下文指纹主键（组装请求侧纯函数产出）。 */
  context_fingerprint: string;
  /** 路径图定义序列化（图定义数据形态；不可序列化图退化为只读身份形态）。 */
  path: Record<string, unknown>;
  /** 路径图指纹（Graph.digest）。 */
  path_fingerprint: string;
  /** 证据快照（组装时域内各边 s/f 计数行）。 */
  evidence_snapshot: readonly Record<string, unknown>[];
  /** 契约版本快照（类型名 → 契约版本对，字典序确定）。 */
  contract_snapshot: readonly (readonly [string, string])[];
  /** 模型标识（钉死：变化 = 降级不命中）。 */
  model_id: string;
  /** 上下文域（容量淘汰按域分组）。 */
  domain: string;
  /** 创建/最近触碰时间戳。 */
  created_at: number;
  updated_at: number;
  /** 命中成功/失败计数（执行回馈可观测）。 */
  hit_count: number;
  fail_count: number;
  /** 失效标记（失效条目不再命中，计数保留）。 */
  invalid: boolean;
};