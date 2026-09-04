/**
 * 知识条目（KnowledgeEntry）：结构化数据载体 + 序列化 + 渲染 + 上下文源适配。
 *
 * 条目 = 补丁链数据（演化 append-only、回退可取旧版本）；层级/类别/来源/
 * 可信度在构造与反序列化期单一校验归口（错误文案携带 KS_ 错误码，桥接
 * 透传不泄露内部字段形态）；渲染层对非 rule/insight 条目做 JSON 摘要软上限
 * 截断——超长 data 不得撑爆注入上下文。
 */

import { ContextSource } from '../context/context_types.js';
import type { Clock } from '../context/context_types.js';
import { GraphDefinitionError } from '../errors.js';
import {
  isRecord,
  stableStringify,
  typeName as _typeName,
  type Json,
  type JsonRecord,
} from '../json.js';
import {
  KS_ERR_CREDIBILITY_RANGE,
  KS_ERR_INVALID_LEVEL,
  KIND_INSIGHT,
  SOURCE_MODEL,
  _LEVELS,
  _MAX_FAILURE_LOGS,
  _MAX_RENDER_CHARS,
  default_credibility,
  isKnowledgeLevel,
  type KnowledgeLevel,
} from './_types.js';

export { SOURCE_MODEL } from './_types.js';
export type { Clock, Json, JsonRecord, KnowledgeLevel };

// 时间 seam 缺省（deterministic：未注入 = 0，纯逻辑可复现）
const DEFAULT_NOW = (): number => 0;

// 条目 id / 存储路径 / CJK 分词等纯工具落 knowledge_utils（知识集域内
// 共享形状单点定义；本文件专注条目结构、序列化与渲染）

// ── 条目内容渲染（知识注入的模型可见形态：标题 + 结构化内容摘要）──

export function _render_entry_content(entry: KnowledgeEntry): string {
  const parts: string[] = [];
  if (entry.title) parts.push(entry.title);
  const rawRule = entry.data.rule;
  if (isRecord(rawRule) && rawRule.message) {
    parts.push(String(rawRule.message));
    return parts.join(' ');
  }
  const insight = entry.data.insight;
  if (entry.kind === KIND_INSIGHT && isRecord(insight) && insight.message) {
    parts.push(String(insight.message));
    if (insight.note) parts.push(`（教训来源：${String(insight.note)}）`);
    return parts.join(' ');
  }
  let rendered = stableStringify(entry.data);
  // 渲染层软上限：非规则条目的 JSON 摘要超限截断 + 溢出标记——条目 data
  // 失控不得撑爆注入上下文（截断内容仍可经条目自身重建，留痕最小化不受影响）
  if (rendered.length > _MAX_RENDER_CHARS) {
    rendered = rendered.substring(0, _MAX_RENDER_CHARS) + '…（渲染截断）';
  }
  parts.push(rendered);
  return parts.join(' ');
}

/** KnowledgeEntry 构造选项（dataclass 字段 + 时间 seam）。 */
export interface KnowledgeEntryOptions {
  id: string;
  level: string;
  kind: string;
  data?: JsonRecord;
  source?: string;
  credibility?: number;
  title?: string;
  tags?: readonly string[];
  usage_count?: number;
  fail_count?: number;
  failure_logs?: readonly string[];
  archived?: boolean;
  created_at?: number;
  updated_at?: number;
  clock?: Clock;
}

/**
 * 一条知识条目（结构化数据，随补丁链版本化；frozen 语义由 readonly
 * 表达——身份 id 跨层级稳定，晋升只迁移层级字段）。
 */
export class KnowledgeEntry {
  readonly id: string;
  readonly level: string;
  readonly kind: string;
  readonly data: JsonRecord;
  readonly source: string;
  readonly credibility: number;
  readonly title: string;
  readonly tags: readonly string[];
  readonly usage_count: number;
  readonly fail_count: number;
  readonly failure_logs: readonly string[];
  readonly archived: boolean;
  readonly created_at: number;
  readonly updated_at: number;
  readonly clock: Clock;

  constructor(options: KnowledgeEntryOptions) {
    // 错误码前缀：文案统一携带 KS_ 码，桥接透传不泄露内部字段形态
    // （层级枚举以可读形态呈现，不裸内部结构）
    if (!isKnowledgeLevel(options.level)) {
      throw new GraphDefinitionError(
        `[${KS_ERR_INVALID_LEVEL}] 知识条目层级非法: ${JSON.stringify(options.level)}` +
          `（仅 ${_LEVELS.join(', ')}）`,
      );
    }
    const credibility = options.credibility ?? 0.5;
    if (!(credibility >= 0 && credibility <= 1)) {
      throw new GraphDefinitionError(
        `[${KS_ERR_CREDIBILITY_RANGE}] 知识条目 ${options.id} 的可信度必须在 [0, 1] 内: ${credibility}`,
      );
    }
    this.clock = options.clock ?? {};
    this.id = options.id;
    this.level = options.level;
    this.kind = options.kind;
    this.data = options.data ? { ...options.data } : {};
    this.source = options.source ?? SOURCE_MODEL;
    this.credibility = credibility;
    this.title = options.title ?? '';
    this.tags = options.tags ? [...options.tags] : [];
    this.usage_count = options.usage_count ?? 0;
    this.fail_count = options.fail_count ?? 0;
    this.failure_logs = options.failure_logs ? [...options.failure_logs] : [];
    this.archived = options.archived ?? false;
    const now = (): number => (this.clock.now ?? DEFAULT_NOW)();
    this.created_at = options.created_at ?? now();
    this.updated_at = options.updated_at ?? now();
  }

  /** 序列化：省略默认值的紧凑形态（tag 列表化、失败日志列表化，往返无损）。 */
  to_dict(): JsonRecord {
    const data: JsonRecord = {
      id: this.id,
      level: this.level,
      kind: this.kind,
      data: this.data,
      source: this.source,
      credibility: this.credibility,
    };
    if (this.title) data.title = this.title;
    if (this.tags.length > 0) data.tags = [...this.tags];
    if (this.usage_count) data.usage_count = this.usage_count;
    if (this.fail_count) data.fail_count = this.fail_count;
    if (this.failure_logs.length > 0) data.failure_logs = [...this.failure_logs];
    if (this.archived) data.archived = true;
    data.created_at = this.created_at;
    data.updated_at = this.updated_at;
    return data;
  }

  /**
   * 反序列化（单点结构校验：类型/枚举/数值域集中本方法；声明式 L1 schema
   * 校验经 KnowledgeSet.verify_through_gate 走闸门路径，两条体系各归其责）。
   */
  static from_dict(data: unknown, options: { clock?: Clock } = {}): KnowledgeEntry {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `知识条目声明非法: 期望 dict，收到 ${_typeName(data)}`,
      );
    }
    const entryId = data.id;
    if (!entryId || typeof entryId !== 'string') {
      throw new GraphDefinitionError('知识条目缺 id（字符串）');
    }
    const level = data.level;
    if (!isKnowledgeLevel(level)) {
      throw new GraphDefinitionError(
        `[${KS_ERR_INVALID_LEVEL}] 知识条目层级非法: ${JSON.stringify(level)}` +
          `（仅 ${_LEVELS.join(', ')}）`,
      );
    }
    const kind = data.kind;
    if (!kind || typeof kind !== 'string') {
      throw new GraphDefinitionError(`知识条目 ${entryId} 缺 kind（字符串）`);
    }
    const rawData = data.data;
    if (!isRecord(rawData)) {
      throw new GraphDefinitionError(
        `知识条目 ${entryId} 的 data 须为 dict，收到 ${_typeName(rawData)}`,
      );
    }
    // Python 形态：falsy（None/空表）→ 空元组；非表/非字符串清单 → 拒绝
    const tags: unknown = data.tags ? data.tags : [];
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
      throw new GraphDefinitionError(`知识条目 ${entryId} 的 tags 须为字符串清单`);
    }
    const failureLogs: unknown = data.failure_logs ? data.failure_logs : [];
    if (
      !Array.isArray(failureLogs) ||
      !failureLogs.every((log) => typeof log === 'string')
    ) {
      throw new GraphDefinitionError(
        `知识条目 ${entryId} 的 failure_logs 须为字符串清单`,
      );
    }
    const source =
      data.source === undefined ? SOURCE_MODEL : String(data.source);
    const rawCredibility =
      data.credibility === undefined
        ? default_credibility(source)
        : data.credibility;
    if (typeof rawCredibility !== 'number' && typeof rawCredibility !== 'boolean') {
      throw new GraphDefinitionError(
        `知识条目 ${entryId} 的 credibility 须为数值，收到 ${_typeName(rawCredibility)}`,
      );
    }
    const credibility = Number(rawCredibility);
    if (!(credibility >= 0 && credibility <= 1)) {
      throw new GraphDefinitionError(
        `知识条目 ${entryId} 的可信度必须在 [0, 1] 内: ${credibility}`,
      );
    }
    const rawUsage = data.usage_count === undefined ? 0 : data.usage_count;
    const rawFail = data.fail_count === undefined ? 0 : data.fail_count;
    // Python 里 bool 是 int 子类，故另判布尔；TS 中 JSON 布尔为独立 typeof，
    // 非 number 一律拒绝（含布尔），整数性用 Number.isInteger 判定
    if (typeof rawUsage !== 'number' || !Number.isInteger(rawUsage)) {
      throw new GraphDefinitionError(
        `知识条目 ${entryId} 的 usage_count 须为整数，收到 ${_typeName(rawUsage)}`,
      );
    }
    if (typeof rawFail !== 'number' || !Number.isInteger(rawFail)) {
      throw new GraphDefinitionError(
        `知识条目 ${entryId} 的 fail_count 须为整数，收到 ${_typeName(rawFail)}`,
      );
    }
    const now = (): number => (options.clock?.now ?? DEFAULT_NOW)();
    const rawCreated = data.created_at === undefined ? now() : data.created_at;
    const rawUpdated = data.updated_at === undefined ? now() : data.updated_at;
    if (typeof rawCreated !== 'number') {
      throw new GraphDefinitionError(
        `知识条目 ${entryId} 的 created_at 须为数值，收到 ${_typeName(rawCreated)}`,
      );
    }
    if (typeof rawUpdated !== 'number') {
      throw new GraphDefinitionError(
        `知识条目 ${entryId} 的 updated_at 须为数值，收到 ${_typeName(rawUpdated)}`,
      );
    }
    // 失败日志留痕截尾：只保留最近 _MAX_FAILURE_LOGS 条（防无限膨胀）
    const logs = (failureLogs as string[]).slice(-_MAX_FAILURE_LOGS);
    return new KnowledgeEntry({
      id: entryId,
      level: level as string,
      kind,
      data: rawData,
      source,
      credibility,
      title: data.title === undefined || data.title === null ? '' : String(data.title),
      tags: tags as string[],
      usage_count: rawUsage as number,
      fail_count: rawFail as number,
      failure_logs: logs,
      archived: Boolean(data.archived),
      created_at: rawCreated,
      updated_at: rawUpdated,
      clock: options.clock,
    });
  }

  /** 条目内容渲染（知识注入的模型可见形态：标题 + 结构化内容摘要；注入前
   *  由 build_knowledge_sources 对渲染内容做指令注入扫描）。 */
  render_content(): string {
    return _render_entry_content(this);
  }

  /**
   * 知识条目 → 上下文源（调配器接入：type=层级、weight=可信度）。
   *
   * 知识集注入 = 调配器思想复用：条目作为源进入预算分配（高可信常驻、
   * 低可信按任务相关度裁剪），逐源留痕由调配器承接。内容 = 条目渲染
   * （标题 + 结构化摘要），与元数据一起进入组装——模型可见皆可重建。
   */
  as_context_source(
    options: {
      relevance?: number;
      ttl?: number | null;
      budget_chars?: number | null;
    } = {},
  ): ContextSource {
    const relevance = options.relevance ?? 0.5;
    if (!(relevance >= 0 && relevance <= 1)) {
      throw new RangeError(`任务相关度必须在 [0, 1] 内: ${relevance}`);
    }
    return new ContextSource(this.level, _render_entry_content(this), {
      title: this.title || this.id,
      weight: this.credibility,
      relevance,
      priority: this.usage_count,
      ttl: options.ttl ?? null,
      max_chars: options.budget_chars ?? null,
      dedup_key: `knowledge:${this.id}`,
      meta: {
        entry_id: this.id,
        kind: this.kind,
        source: this.source,
        level: this.level,
      },
      created_at: this.updated_at,
    });
  }
}