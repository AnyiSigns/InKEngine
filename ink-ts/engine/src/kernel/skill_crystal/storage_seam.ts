/**
 * 技能存储 seam：核心域以接口表达（零 sqlite / 零 IO），宿主侧注入 sqlite
 * 实现（镜像 Python aiosqlite 独立表 skills 的列语义与 (name, version) 复合
 * 主键约束）。本 seam 只表达行级原语（整行写 / 按名取 / 按指纹取 / 枚举 /
 * 删 / 计数）；去重与版本递增等机制判定归 skill_store / crystallize 层。
 *
 * Row 直接镜像 Python _SCHEMA_SQL 的列；复杂字段（path/evidence/contract/
 * test_report）以 JSON 字符串落列，由 skill_store 序列化/反序列化。宿主
 * sqlite 实现的建表基准（幂等）：
 *
 *   CREATE TABLE IF NOT EXISTS skills (
 *     name TEXT NOT NULL,
 *     version INTEGER NOT NULL DEFAULT 1,
 *     domain TEXT NOT NULL DEFAULT 'default',
 *     fingerprint TEXT NOT NULL,
 *     kind TEXT NOT NULL DEFAULT 'path',
 *     path_data TEXT NOT NULL DEFAULT '{}',
 *     contract_snapshot TEXT NOT NULL DEFAULT '[]',
 *     evidence_snapshot TEXT NOT NULL DEFAULT '[]',
 *     model_id TEXT NOT NULL DEFAULT '',
 *     hit_count INTEGER NOT NULL DEFAULT 0,
 *     fail_count INTEGER NOT NULL DEFAULT 0,
 *     test_report TEXT NOT NULL DEFAULT '{}',
 *     source_path TEXT NOT NULL DEFAULT '',
 *     created_at REAL NOT NULL,
 *     updated_at REAL NOT NULL,
 *     PRIMARY KEY (name, version)
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills(domain);
 */

/** 技能表行（镜像 Python _SCHEMA_SQL 的列；(name, version) 复合主键）。 */
export type SkillRow = {
  name: string;
  version: number;
  domain: string;
  fingerprint: string;
  kind: string;
  path_data: string;
  contract_snapshot: string;
  evidence_snapshot: string;
  model_id: string;
  hit_count: number;
  fail_count: number;
  test_report: string;
  source_path: string;
  created_at: number;
  updated_at: number;
};

/** 技能持久化 seam：core 零 IO、宿主注入实现（复合主键 name+version）。 */
export interface SkillStorage {
  /** 整行写入（同 (name, version) = 顶替整行替换；版本递增由调用方负责）。 */
  upsert_row(row: SkillRow): Promise<void>;
  /** 按 (name, version) 精确取行（不存在 = null）。 */
  lookup_row(name: string, version: number): Promise<SkillRow | null>;
  /** 按名取最新版本行（ORDER BY version DESC LIMIT 1；不存在 = null）。 */
  lookup_latest_row(name: string): Promise<SkillRow | null>;
  /** 按来源指纹取最新版本行（结晶去重/版本递增判定用；不存在 = null）。 */
  lookup_latest_row_by_fingerprint(fingerprint: string): Promise<SkillRow | null>;
  /** 枚举行（domain=null 或 '' = 全域；按 name 升序 + version 升序确定性序）。 */
  list_rows(domain?: string | null): Promise<SkillRow[]>;
  /** 删除某技能全部版本（派生数据可重建）；有删除 = true。 */
  remove_rows(name: string): Promise<boolean>;
  /** 行计数（含全部版本；domain=null 或 '' = 全域）。 */
  count_rows(domain?: string | null): Promise<number>;
  /** 关闭连接（可选；无连接实现可空实现）。 */
  close?(): Promise<void>;
}
