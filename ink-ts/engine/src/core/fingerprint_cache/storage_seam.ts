/**
 * 指纹缓存存储 seam：核心域以接口表达（零 sqlite / 零 IO），宿主侧注入
 * sqlite（镜像 Python aiosqlite 独立表 fingerprint_cache 的列语义与主键
 * 约束）。本 seam 只表达行级原语（整行写 / 条件读 / 条件改 / 删 / 计数 /
 * 枚举）；质量的「概率闸门、容量淘汰」等机制判定归 store 层，不在存储体。
 *
 * Row 直接镜像 Python 表列：复杂字段（path/evidence/contract）以稳定
 * JSON 字符串落列，由 store 层序列化/反序列化；invalid 用 0|1 表达布尔。
 */

/** 指纹缓存表行（镜像 Python _SCHEMA_SQL 的列；context_fingerprint 主键）。 */
export type FingerprintCacheRow = {
  context_fingerprint: string;
  path_data: string;
  path_fingerprint: string;
  evidence_snapshot: string;
  contract_snapshot: string;
  model_id: string;
  domain: string;
  created_at: number;
  updated_at: number;
  hit_count: number;
  fail_count: number;
  invalid: 0 | 1;
};

/** 指纹缓存持久化 seam：core 零 IO、宿主注入实现。 */
export interface FingerprintCacheStorage {
  /** 整行写入（已存在同主键 = 顶替：整行替换、计数清零、失效标记复位）。 */
  upsert_row(row: FingerprintCacheRow): Promise<void>;
  /** 按主键取有效行（invalid 置位行不可见——降级不命中而非静默复用）。 */
  lookup_row(fingerprint: string): Promise<FingerprintCacheRow | null>;
  /** 按主键取任意行（含失效；审计/测试/顶替比较用）。 */
  get_row(fingerprint: string): Promise<FingerprintCacheRow | null>;
  /** 标记失效（invalid=0 → 1 且刷新 updated_at）；已失效/不存在 = false。 */
  invalidate_row(fingerprint: string, ts: number): Promise<boolean>;
  /** 命中回馈（hit_count +1 并刷新 updated_at）；不存在 = false。 */
  report_hit(fingerprint: string, ts: number): Promise<boolean>;
  /** 失败回馈（fail_count +1、置失效并刷新 updated_at；仅有效行）；不变更 = false。 */
  report_fail(fingerprint: string, ts: number): Promise<boolean>;
  /** 物理移除（容量淘汰/清理用；派生数据可重建）。 */
  remove_row(fingerprint: string): Promise<boolean>;
  /** 条目计数（含失效；domain=null 或 '' = 全域计数）。 */
  count_rows(domain?: string | null): Promise<number>;
  /** 枚举行（含失效；domain=null 或 '' = 全域；按 context_fingerprint 升序）。 */
  list_rows(domain?: string | null): Promise<FingerprintCacheRow[]>;
  /** 关闭连接（可选；无连接实现可空实现）。 */
  close?(): Promise<void>;
}