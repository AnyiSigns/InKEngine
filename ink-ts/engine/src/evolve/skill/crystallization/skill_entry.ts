/**
 * 技能条目（SkillEntry）：命名化缓存条目的值对象（镜像 Python dataclass）。
 *
 * 派生数据，可由指纹缓存运行历史重建；frozen 语义由 readonly 表达（构造后
 * 字段不可变，与知识条目同纪律）。path 为路径图定义序列化（可重建 DOM/图），
 * contract_snapshot 契约版本快照（类型名 → 契约版本对）、evidence_snapshot
 * 证据快照（域内各边 s/f 计数行）与 test_report 均随导出分享。
 */

/** SkillEntry 构造选项（Python dataclass 字段的 kw-only 映射）。 */
export interface SkillEntryOptions {
  /** 技能身份（同名重结晶 = 版本递增，旧版本保留可追溯）。 */
  name: string;
  version: number;
  /** 上下文域（与指纹缓存同源）。 */
  domain: string;
  /** 来源路径指纹（Graph.digest；技能可追溯回缓存条目）。 */
  fingerprint: string;
  /** path 通用路径技能 / visual 视觉技能（输入 image→结构化提取）。 */
  kind: string;
  /** 路径图定义序列化（可重建 DOM/图）。 */
  path: Record<string, unknown>;
  /** 契约版本快照（类型名 → 契约版本对；缺省空表）。 */
  contract_snapshot?: readonly (readonly [string, string])[];
  /** 证据快照（域内各边 s/f 计数行；缺省空表）。 */
  evidence_snapshot?: readonly Record<string, unknown>[];
  /** 模型标识（结晶时钉死）。 */
  model_id: string;
  /** 结晶所据命中/失败计数（来源缓存条目）。 */
  hit_count: number;
  fail_count: number;
  /** 测试报告（命中率/样本边/生成时间，随导出分享；缺省空表）。 */
  test_report?: Record<string, unknown>;
  /** 来源路径指纹（可读来源标识，与 fingerprint 同源）。 */
  source_path: string;
  /** 创建/最近触碰时间戳。 */
  created_at: number;
  updated_at: number;
}

/**
 * 一条技能（命名化缓存条目；派生数据，可由指纹缓存重建）。
 * 属性语义与 Python SkillEntry dataclass 对齐；tuple 语义由 readonly 表达。
 */
export class SkillEntry {
  readonly name: string;
  readonly version: number;
  readonly domain: string;
  readonly fingerprint: string;
  readonly kind: string;
  readonly path: Record<string, unknown>;
  readonly contract_snapshot: readonly (readonly [string, string])[];
  readonly evidence_snapshot: readonly Record<string, unknown>[];
  readonly model_id: string;
  readonly hit_count: number;
  readonly fail_count: number;
  readonly test_report: Record<string, unknown>;
  readonly source_path: string;
  readonly created_at: number;
  readonly updated_at: number;

  constructor(options: SkillEntryOptions) {
    this.name = options.name;
    this.version = options.version;
    this.domain = options.domain;
    this.fingerprint = options.fingerprint;
    this.kind = options.kind;
    this.path = options.path ? { ...options.path } : {};
    this.contract_snapshot = options.contract_snapshot
      ? options.contract_snapshot.map((pair) => [pair[0], pair[1]] as const)
      : [];
    this.evidence_snapshot = options.evidence_snapshot
      ? options.evidence_snapshot.map((row) => ({ ...row }))
      : [];
    this.model_id = options.model_id;
    this.hit_count = options.hit_count;
    this.fail_count = options.fail_count;
    this.test_report = options.test_report ? { ...options.test_report } : {};
    this.source_path = options.source_path;
    this.created_at = options.created_at;
    this.updated_at = options.updated_at;
  }
}
