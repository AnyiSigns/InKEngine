/**
 * 记忆策略原语（领域复用：各类 agent 通用）。
 *
 * 记忆 = 带元数据的条目累积（来源/权重/时效），取用 = 召回策略按时间线
 * 与权重筛选。引擎只定义存储接口与召回/失效策略契约，不绑定具体持久化
 * 与业务语义——任意宿主记忆（结构化记忆/文件记忆/向量记忆）实现同一
 * MemoryStore 协议即可互换。
 *
 * 分层语义（业务层职责，引擎不约束）：工作记忆（回合内域窗口/消息）、
 * 长程记忆（每对象）、风格记忆（用户偏好）都是 MemoryEntry 的
 * namespace/kind 区分；召回策略按 namespace + kind + 权重排序取用。
 *
 * 删除对非破坏性开放：forget = 标记失效而非物理擦除，与引擎 Event
 * Sourcing 哲学一致，失效记录仍可追溯。
 *
 * TS seam 差异：time/uuid 属副作用，由调用方经 now/id_gen 注入（等价
 * Python time.time / uuid.uuid4().hex），缺省按确定值（now→0、id→固定
 * 32 位 hex）保证纯函数可复现；get_logger 属可观测性副作用，core 不落。
 */

import { isRecord } from '../json.js';
import { _SOURCE_CREDIBILITY } from '../source_grading/sourceGrading.js';

/** 时间源 seam（等价 Python time.time）；未注入时按确定值 0。 */
export type NowFn = () => number;

/** 十六进制串源 seam（等价 Python uuid.uuid4().hex）；未注入固定串。 */
export type IdGenFn = () => string;

/** 缺省时间源：确定值 0（镜像 ledger/audit_log 同款缺省）。 */
export const DEFAULT_NOW: NowFn = (): number => 0;

/** 缺省 id 源：固定 32 位十六进制，保证确定性可复现。 */
export const DEFAULT_ID_GEN: IdGenFn = (): string => '00000000000000000000000000000000';

// 来源分级 → 默认召回权重（复用 source_grading 分级基准）。记忆来源取值
// 宿主语义，但当来源落在统一分级词汇表（web/dialog/model/user）内时，
// 默认权重 = 该级可信度基准——与知识条目 credibility、检索 chunk level
// 同源同口径；词汇表外来源回落中性 1.0（非可信度语义的来源不套用分级）。
export const SOURCE_WEIGHT_BY_SOURCE: Readonly<Record<string, number>> = {
  ..._SOURCE_CREDIBILITY,
};

/** MemoryEntry 构造入参（缺省字段走默认值；created_at 缺省取注入 now）。 */
export interface MemoryEntryInput {
  namespace: string;
  kind: string;
  content: string;
  id?: string | null;
  title?: string | null;
  source?: string;
  priority?: number;
  weight?: number;
  meta?: Record<string, unknown>;
  created_at?: number;
  expires_at?: number | null;
}

/** MemoryEntry 命名选项：时间源 seam 注入面。 */
export interface MemoryEntryOptions {
  now?: NowFn;
}

/**
 * 单条记忆条目（带元数据的累积单元）。
 *
 * 属性：
 * - namespace: 记忆域（用户级 "user:<id>" 或 对象级 "object:<id>"），
 *   区分工作/长程/风格记忆的作用边界。
 * - content: 记忆内容。
 * - id: 条目唯一 id（存储实现分配，新建时为 null）。
 * - title: 可选标题（列表可读）。
 * - source: 来源（宿主语义，如 "decision"/"domain_window"/"self_reflection"）。
 * - priority: 优先级（数值大优先，召回排序用）。
 * - weight: 召回权重（相关度维度，确定性召回外的融合用）。来源落在
 *   统一分级词汇表内时，未显式声明的权重默认 = 该级可信度基准
 *   （来源/权重与知识集、检索同一套分级类型）。
 * - meta: 业务元数据（宿主语义，如 domain/related_entity_id/...）。
 * - created_at: 创建时间戳（epoch 秒）。
 * - expires_at: 失效时间戳（null = 不过期；时效失效策略用）。
 *
 * frozen 语义（镜像 Python frozen dataclass）：构造后冻结；weight 在
 * 构造期完成来源分级默认覆盖——显式 1.0 与默认不可区分，同按分级基准
 * 覆盖（需要中性权重的分级来源可显式用词汇表外来源名）。
 */
export class MemoryEntry {
  readonly namespace: string;
  readonly kind: string;
  readonly content: string;
  readonly id: string | null;
  readonly title: string | null;
  readonly source: string;
  readonly priority: number;
  readonly weight: number;
  readonly meta: Record<string, unknown>;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly #now: NowFn;

  constructor(input: MemoryEntryInput, options: MemoryEntryOptions = {}) {
    const now = options.now ?? DEFAULT_NOW;
    this.namespace = input.namespace;
    this.kind = input.kind;
    this.content = input.content;
    this.id = input.id ?? null;
    this.title = input.title ?? null;
    this.source = input.source ?? 'manual';
    this.priority = input.priority ?? 5;
    let weight = input.weight ?? 1.0;
    if (weight === 1.0 && this.source in SOURCE_WEIGHT_BY_SOURCE) {
      weight = SOURCE_WEIGHT_BY_SOURCE[this.source] ?? 1.0;
    }
    this.weight = weight;
    this.meta = input.meta ?? {};
    this.created_at = input.created_at ?? now();
    this.expires_at = input.expires_at ?? null;
    this.#now = now;
    Object.freeze(this);
  }

  /** 时效判定：now 缺省取注入时间源（数值 0 同 Python `or` 语义回落）。 */
  is_expired(now?: number | null): boolean {
    if (this.expires_at === null) return false;
    const t = now || this.#now();
    return t >= this.expires_at;
  }
}

/** 记忆查询条件（存储实现按字段过滤）。 */
export interface MemoryQuery {
  namespace?: string | null;
  kind?: string | null;
  source?: string | null;
  limit?: number | null;
}

/**
 * 记忆召回策略（取用 = 召回 + 排序 + 截断）。
 *
 * 确定性召回（默认）：过滤未过期条目，按 priority 降序、created_at
 * 降序排序，截断 top-k。相关度/权重维度由业务扩展实现（如语义检索
 * 结果注入 weight）后复用同一契约。
 */
export interface MemoryRecallPolicy {
  recall(
    entries: readonly MemoryEntry[],
    options?: { limit?: number | null },
  ): MemoryEntry[];
}

/** PriorityRecallPolicy 选项：时间源 seam（缺省确定值 0）。 */
export interface PriorityRecallPolicyOptions {
  now?: NowFn;
}

/** 默认召回策略：优先级 + 时效 + 时间线排序的确定性召回。 */
export class PriorityRecallPolicy implements MemoryRecallPolicy {
  readonly #now: NowFn;

  constructor(options: PriorityRecallPolicyOptions = {}) {
    this.#now = options.now ?? DEFAULT_NOW;
  }

  recall(
    entries: readonly MemoryEntry[],
    options?: { limit?: number | null },
  ): MemoryEntry[] {
    const now = this.#now();
    const alive = entries.filter((entry) => !entry.is_expired(now));
    alive.sort((left, right) => {
      const byPriority = right.priority - left.priority;
      return byPriority !== 0 ? byPriority : right.created_at - left.created_at;
    });
    const limit = options?.limit ?? null;
    return limit !== null ? alive.slice(0, limit) : alive;
  }
}

/** 新建条目 id 生成（namespace 域内唯一即可，复用者无需关系型主键）。 */
export function _make_id(entry: MemoryEntry, id_gen: IdGenFn = DEFAULT_ID_GEN): string {
  return `${entry.namespace}:${id_gen()}`;
}

/** MemoryEntry → 存储记录（结构化 JSON，通用存储服务直接落库）。 */
export function _entry_to_record(
  entry: MemoryEntry,
  entry_id: string,
): Record<string, unknown> {
  return {
    id: entry_id,
    namespace: entry.namespace,
    kind: entry.kind,
    content: entry.content,
    title: entry.title,
    source: entry.source,
    priority: entry.priority,
    weight: entry.weight,
    meta: entry.meta,
    created_at: entry.created_at,
    expires_at: entry.expires_at,
  };
}

/** 数值字段兼容旧记录：缺失/非数值回落缺省（Python int()/float() 的
 *  严格报错路径在 TS 宽松化——记录来源不可控，宁取缺省不抛）。 */
function _to_number(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

/** Python int() 口径：数字截断取整。 */
function _to_int(value: unknown, fallback: number): number {
  return Math.trunc(_to_number(value, fallback));
}

/** Python float() 口径：数值解析。 */
function _to_float(value: unknown, fallback: number): number {
  return _to_number(value, fallback);
}

/** meta 兼容旧记录：缺失/空容器回落新空对象（Python `or {}` 语义）。 */
function _to_meta(value: unknown): Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0 ? value : {};
}

/**
 * 存储记录 → MemoryEntry（字段缺失走默认值，兼容旧记录）。
 * created_at 缺省取注入 now（镜像 Python float(rec.get("created_at",
 * time.time()))）。
 */
export function _record_to_entry(
  rec: Record<string, unknown>,
  now: NowFn = DEFAULT_NOW,
): MemoryEntry {
  return new MemoryEntry({
    id: typeof rec['id'] === 'string' ? rec['id'] : null,
    namespace: typeof rec['namespace'] === 'string' ? rec['namespace'] : '',
    kind: typeof rec['kind'] === 'string' ? rec['kind'] : '',
    content: typeof rec['content'] === 'string' ? rec['content'] : '',
    title: typeof rec['title'] === 'string' ? rec['title'] : null,
    source: typeof rec['source'] === 'string' ? rec['source'] : 'manual',
    priority: _to_int(rec['priority'], 5),
    weight: _to_float(rec['weight'], 1.0),
    meta: _to_meta(rec['meta']),
    created_at: _to_float(rec['created_at'], now()),
    expires_at: typeof rec['expires_at'] === 'number' ? rec['expires_at'] : null,
  });
}