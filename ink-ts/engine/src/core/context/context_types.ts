/**
 * 上下文调配器数据形态：源元数据 + 留痕记录 + 装配结果（context.py 数据面移植）。
 *
 * 预算单位 = 字符（引擎无分词器，字符数是对 token 的确定性近似；
 * 宿主按模型上下文窗换算）。ContextSource 是冻结值对象（frozen 语义
 * 由 readonly + 构造期校验表达），所有字段 JSON 兼容。
 */

/** 默认装配预算（字符）：与宿主旧静态取段 4000 上限对齐，宿主可覆盖。 */
export const DEFAULT_BUDGET_CHARS = 4000;

/** 相关度默认值（未显式声明时取中值，防全默认 = 全相同导致预算均分）。 */
export const DEFAULT_RELEVANCE = 0.5;

/** 高权重源全保留阈值：score = weight × relevance ≥ 该值 → 预算内整源保留。 */
export const KEEP_FULL_THRESHOLD = 0.8;

/** 中权重源截断门槛：score ≥ 该值 → 按预算份额截断保留；低于 → 丢弃。 */
export const TRUNCATE_MIN_SCORE = 0.15;

/** 截断保留的字符下限：份额低于该值不值得保留（近似噪音），直接丢弃。 */
export const MIN_TRUNCATE_CHARS = 100;

/** 分配模式（确定性层的三种处理档位）。 */
export const MODE_KEEP_FULL = 'keep_full';
export const MODE_TRUNCATE = 'truncate';
export const MODE_DROP = 'drop';

/** 时间注入面：纯函数可复现（避免隐式 Date.now 依赖）。 */
export interface Clock {
  /** 取当前 epoch 秒；未注入时按 0。 */
  now?: () => number;
}

const DEFAULT_NOW = (): number => 0;

/** ContextSource 构造选项。 */
export interface ContextSourceOptions {
  title?: string | null;
  weight?: number;
  relevance?: number;
  priority?: number;
  ttl?: number | null;
  max_chars?: number | null;
  dedup_key?: string | null;
  meta?: Record<string, unknown>;
  created_at?: number;
  /** 注入的时间源；用于 created_at 缺省与 is_expired 缺省调用。 */
  clock?: Clock;
}

/**
 * 单个上下文源（带元数据的融合输入）。
 *
 * 字段语义：
 * - type：源类型（业务自定义：topic/memory/entity/state/...）；
 * - content：源文本（空内容 = 无意义源，分配时剔除）；
 * - title：可选标题（装配时作块标题行，留痕可读）；
 * - weight：权重（预算分配主因子，数值大多分配）；
 * - relevance：相关度（0-1，与当前任务的匹配度，预算分配次因子）；
 * - priority：优先级（同分时排序，数值大在前）；
 * - ttl：时效秒数（None = 不过期；过期源分配时剔除）；
 * - max_chars：该源保留上限（None = 不设额外上限）；
 * - dedup_key：跨源去重键（同键源只保留优先级最高者）；
 * - meta：扩展元数据（来源引用/目标标识等，装配留痕透传）；
 * - created_at：创建时间戳（epoch 秒，ttl 基准）。
 */
export class ContextSource {
  readonly type: string;
  readonly content: string;
  readonly title: string | null;
  readonly weight: number;
  readonly relevance: number;
  readonly priority: number;
  readonly ttl: number | null;
  readonly max_chars: number | null;
  readonly dedup_key: string | null;
  readonly meta: Record<string, unknown>;
  readonly created_at: number;
  /** 构造期注入的时间源；is_expired 缺省参数时复用（保持全源时钟一致）。 */
  readonly clock: Clock;

  constructor(type: string, content: string, options: ContextSourceOptions = {}) {
    const opts = options;
    if (opts.weight !== undefined && opts.weight < 0) {
      throw new RangeError(`源权重不能为负: ${opts.weight}`);
    }
    if (opts.relevance !== undefined && !(opts.relevance >= 0 && opts.relevance <= 1)) {
      throw new RangeError(`源相关度必须在 [0, 1] 内: ${opts.relevance}`);
    }
    if (opts.ttl !== undefined && opts.ttl !== null && opts.ttl < 0) {
      throw new RangeError(`源时效不能为负: ${opts.ttl}`);
    }
    if (opts.max_chars !== undefined && opts.max_chars !== null && opts.max_chars < 0) {
      throw new RangeError(`源保留上限不能为负: ${opts.max_chars}`);
    }
    this.type = type;
    this.content = content;
    this.title = opts.title ?? null;
    this.weight = opts.weight ?? 1.0;
    this.relevance = opts.relevance ?? DEFAULT_RELEVANCE;
    this.priority = opts.priority ?? 5;
    this.ttl = opts.ttl ?? null;
    this.max_chars = opts.max_chars ?? null;
    this.dedup_key = opts.dedup_key ?? null;
    this.meta = opts.meta ? { ...opts.meta } : {};
    this.clock = opts.clock ?? {};
    this.created_at = opts.created_at ?? (this.clock.now ?? DEFAULT_NOW)();
  }

  /** 按 ttl 判定源是否过期（null ttl = 永不过期）。 */
  is_expired(now?: number | null): boolean {
    if (this.ttl === null) return false;
    const current =
      now === undefined || now === null ? (this.clock.now ?? DEFAULT_NOW)() : now;
    return current - this.created_at >= this.ttl;
  }

  /** 确定性层分配分 = 权重 × 相关度（单一排序键，可解释）。 */
  score(): number {
    return this.weight * this.relevance;
  }
}

/**
 * 单个源的预算分配结果（确定性层三种档位）。
 *
 * - source：分配对象；
 * - mode：分配模式（keep_full/truncate/drop）；
 * - char_limit：该源可用字符上限（drop 为 0）；
 * - reason：分配理由（留痕可读：高权重全保留/预算份额/时效过期/低于门槛…）。
 */
export class SourceAllocation {
  readonly source: ContextSource;
  readonly mode: string;
  readonly char_limit: number;
  readonly reason: string;

  constructor(source: ContextSource, mode: string, char_limit: number, reason: string) {
    this.source = source;
    this.mode = mode;
    this.char_limit = char_limit;
    this.reason = reason;
  }
}

/** 装配留痕：一个被纳入源的使用明细（审计「喂了什么」）。 */
export class SourceInclusion {
  readonly type: string;
  readonly title: string | null;
  readonly mode: string;
  readonly chars: number;

  constructor(type: string, title: string | null, mode: string, chars: number) {
    this.type = type;
    this.title = title;
    this.mode = mode;
    this.chars = chars;
  }
}

/** 装配留痕：一个被丢弃的源（原因可读，便于调预算）。 */
export class DroppedSource {
  readonly type: string;
  readonly title: string | null;
  readonly reason: string;

  constructor(type: string, title: string | null, reason: string) {
    this.type = type;
    this.title = title;
    this.reason = reason;
  }
}

/**
 * 装配结果：最终文本 + 逐源留痕（可审计/可回退）。
 *
 * - text：装配产物（长度 ≤ total_chars，硬上界）；
 * - included：被纳入源的使用明细（按装配顺序）；
 * - dropped：被丢弃源及原因；
 * - total_chars：本次预算；
 * - used_chars：实际使用字符数（分隔符计入）；
 * - fused：是否经 LLM 融合钩子产出（否则为确定性组装）。
 */
export class AssembledContext {
  readonly text: string;
  readonly included: readonly SourceInclusion[];
  readonly dropped: readonly DroppedSource[];
  readonly total_chars: number;
  readonly used_chars: number;
  readonly fused: boolean;

  constructor(
    text: string,
    included: readonly SourceInclusion[] = [],
    dropped: readonly DroppedSource[] = [],
    total_chars: number = DEFAULT_BUDGET_CHARS,
    used_chars: number = 0,
    fused: boolean = false,
  ) {
    this.text = text;
    this.included = included;
    this.dropped = dropped;
    this.total_chars = total_chars;
    this.used_chars = used_chars;
    this.fused = fused;
  }
}