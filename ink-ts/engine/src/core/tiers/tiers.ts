/**
 * 模型分层挡位原语（挡位配置模型 / 按挡位建链 / 调用统计钩子）——tiers.py 移植。
 *
 * 模型分层：router/main 双挡位（轻量/主）按场景分配——路由决策用轻量挡，
 * 内容生成用主挡。组 → 挡位映射属宿主业务语义，引擎只提供机制：
 * 挡位名 → 配置键前缀、单挡位配置解析、按挡位建链与挡位调用统计。
 *
 * 配置形态：model_config 为 dict，挡位配置键 = f"{tier}_config"（缺省回退
 * main_config），备用链键 = f"{tier}_fallback_configs"（兼容历史嵌套
 * fallback_configs）。显式空配置（{}）与缺失键区分：前者 = 该挡位显式
 * 声明无配置（不回落主挡位），后者 = 回落 main。
 *
 * 依赖注入：build_tier_chain 的 create / retry 可注入；ModelChain 的
 * 重试/备用/流式执行属 llm 层（未移植），本模块只负责按挡位装配有序的
 * 模型配置清单（configs = [主配置, ...备用]），llm 层移植后接线。
 */

import { isRecord, type JsonRecord } from '../json.js';

/** 默认挡位声明（装配注入前的出厂形态：main/router 双挡）。 */
export const TIER_NAMES = ['main', 'router'] as const;

/** 未知挡位的回落锚点：任何未知/None 挡位按主挡位处理（配置兜底语义）。 */
const DEFAULT_TIER = 'main';

/** 生效中的挡位声明（数据驱动：set_tier_names 整组替换，校验直过）。 */
let activeTierNames: readonly string[] = TIER_NAMES;

/** Python str() 口径的标量渲染（挡位声明归一化；None → 'None'）。 */
function nameStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return value;
  return String(value);
}

/** Python tuple repr 口径（错误消息携带声明清单，便于定位）。 */
function tupleRepr(names: readonly string[]): string {
  return `(${names.map((name) => `'${name}'`).join(', ')})`;
}

/** 当前生效的挡位声明（观察侧；装配注入后立即反映；拷贝防外部污染）。 */
export function current_tier_names(): readonly string[] {
  return [...activeTierNames];
}

/** 装配注入：以数据声明挡位集合；声明即权威（整组替换），main 必须存在。 */
export function set_tier_names(names: readonly unknown[]): void {
  const normalized = names.map(nameStr);
  if (normalized.length === 0) {
    throw new Error('挡位声明不能为空（至少须含 main）');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`挡位声明含重复项: ${tupleRepr(normalized)}`);
  }
  if (normalized.some((name) => name === '')) {
    throw new Error('挡位名不能为空字符串');
  }
  if (!normalized.includes(DEFAULT_TIER)) {
    throw new Error(`挡位声明缺回落锚点 '${DEFAULT_TIER}': ${tupleRepr(normalized)}`);
  }
  activeTierNames = normalized;
}

/** 挡位名 → 配置键前缀；未知或 None 回落 main（防拼写错误静默换挡）。 */
export function tier_key(tier: string | null | undefined): string {
  return typeof tier === 'string' && activeTierNames.includes(tier) ? tier : DEFAULT_TIER;
}

/** 单挡位的模型配置形态（frozen 数据：tier/config/fallbacks）。 */
export class TierConfig {
  readonly tier: string;
  readonly config: JsonRecord | null;
  readonly fallbacks: readonly JsonRecord[];

  constructor(tier: string, config: JsonRecord | null, fallbacks: readonly JsonRecord[]) {
    this.tier = tier;
    this.config = config;
    this.fallbacks = fallbacks;
  }
}

function recordOf(value: unknown): JsonRecord | null {
  return isRecord(value) ? (value as JsonRecord) : null;
}

/**
 * 从用户模型配置解析指定挡位的配置形态（纯函数）。
 * 主配置 = f"{tier}_config"，缺省回退 main_config；备用列表 =
 * f"{tier}_fallback_configs"，兼容历史嵌套 config["fallback_configs"]；
 * 全部缺失 → config=null（调用方按无配置处理，不抛错）。
 */
export function resolve_tier_config(
  model_config: JsonRecord | null | undefined,
  tier: string | null | undefined,
): TierConfig {
  const key = tier_key(tier);
  const cfgMap = model_config ?? {};
  let cfg: unknown = cfgMap[`${key}_config`];
  if (cfg === null || cfg === undefined) cfg = cfgMap['main_config'];
  if (cfg === null || cfg === undefined) cfg = {};
  const cfgRecord = recordOf(cfg);
  let tierFallbacks: unknown = cfgMap[`${key}_fallback_configs`];
  if (tierFallbacks === null || tierFallbacks === undefined) {
    tierFallbacks = cfgRecord === null ? undefined : cfgRecord['fallback_configs'];
  }
  const fallbackList = Array.isArray(tierFallbacks) ? tierFallbacks : [];
  const config = cfgRecord !== null && Object.keys(cfgRecord).length > 0 ? cfgRecord : null;
  return new TierConfig(key, config, [...(fallbackList as JsonRecord[])]);
}

/** 链装配结果：ModelChain 的 configs 观察面（主配置在前，备用随后；类型不出模块）。 */
interface ModelChain {
  readonly configs: readonly JsonRecord[];
}

/**
 * 按挡位构建模型链（主配置 + 备用链）；配置缺失返回 null。
 * 该挡位与主挡位均无配置时返回 null（调用方按配置缺失兜底）。
 * create/retry 为 llm 层 seam（llm 未移植，仅保留注入面，暂不消费）。
 */
export function build_tier_chain(
  model_config: JsonRecord | null | undefined,
  tier: string | null = null,
  options: { create?: (config: JsonRecord) => unknown; retry?: unknown } = {},
): ModelChain | null {
  void options;
  const resolved = resolve_tier_config(model_config, tier);
  if (resolved.config === null) return null;
  return { configs: [resolved.config, ...resolved.fallbacks] };
}

/** 挡位调用统计钩子：按挡位累加 LLM 调用次数，供回合级观测。 */
export class TierCallStats {
  private counts = new Map<string, number>();

  /** 累加一次（或多次）某挡位的调用数；未知挡位归一后记录，非正计数忽略。 */
  record(tier: string | null | undefined, count = 1): void {
    if (count <= 0) return;
    const key = tier_key(tier);
    this.counts.set(key, (this.counts.get(key) ?? 0) + count);
  }

  /** 当前计数快照（{挡位: 次数}，未调用过的挡位不出现）。 */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [tier, count] of this.counts) out[tier] = count;
    return out;
  }

  /** 清零（新回合复用实例时调用）。 */
  reset(): void {
    this.counts.clear();
  }

  /** 合并另一实例的计数（+= 语义；嵌套图/子图回流场景汇总），返回自身。 */
  merge(other: TierCallStats): this {
    for (const [tier, count] of other.counts) {
      this.counts.set(tier, (this.counts.get(tier) ?? 0) + count);
    }
    return this;
  }
}
