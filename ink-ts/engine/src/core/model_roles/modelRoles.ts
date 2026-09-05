/**
 * 角色模型槽原语（角色槽配置模型 / 按角色建链 / 角色调用统计钩子）。
 *
 * 本模块替代 core/tiers（模型分层挡位）。语义差异：
 * - 角色槽是**固定语义命名**（agent/router），不是数据驱动的可变挡位
 *   声明——`set_tier_names`/`current_tier_names` 的模块级可变状态不再存在，
 *   引擎机制零模块级可变状态；角色名想扩展（新增功能槽）直接在机制侧声明
 *   新常量，未知角色一律归一 agent 兜底（防拼写错误静默换用其它槽）。
 * - agent 槽 = 会话/主链模型：唯一带身份/连续性语义的角色，是会话默认模型
 *   （实体 model:None 落它）与**唯一兜底槽**。router 为功能槽：非
 *   agent、无 persona，被引擎机制按明确用途调用（router = 蒸馏判定/轻量
 *   决策）。功能槽未配置 → **显式回落 agent**（source_role/
 *   fallback 标记来源，可观测不静默）。
 * - 配置形态：model_config 为 dict，角色配置键 = `{role}_config`（agent 槽
 *   另兼容历史别名 main_config，agent_config 优先），备用链键 =
 *   `{role}_fallback_configs`（兼容历史嵌套 config["fallback_configs"]）。
 *   与旧 tiers 的差异：显式空配置 {} 与缺失键**同走回落路径**（旧语义把
 *   {} 视为「显式声明无配置、不回落主挡」；新语义下空对象 = 该槽未配置 →
 *   回落 agent——功能槽只有**非空 record** 才算配置）。
 *
 * 依赖注入：build_role_model_chain 的 create / retry 保留注入面；ModelChain
 * 的重试/备用/流式执行属 llm 层，本模块只负责按角色槽装配有序的模型配置
 * 清单（configs = [主配置, ...备用]），llm 层接线后消费。
 */

import { isRecord, type JsonRecord } from '../json.js';

/** agent 槽角色名：会话/主链模型（唯一带身份/连续性语义，会话默认模型兜底槽）。 */
export const ROLE_AGENT = 'agent';
/** router 槽角色名（功能槽）：蒸馏判定/轻量决策（非 agent、无 persona）。 */
export const ROLE_ROUTER = 'router';

/** 出厂固定角色槽声明。router 之后仍可扩展功能角色（机制侧加常量即
 *  生效，无需声明式装配注入）；扩展角色与 agent/router 同等解析。 */
export const MODEL_ROLES = ['agent', 'router'] as const;

/** 默认角色槽：agent（唯一兜底锚点；未知/None 角色归一于此）。 */
export const DEFAULT_ROLE = ROLE_AGENT;

/** 角色配置键的兼容别名表：canonical 键 → 历史旧键清单（依序尝试，canonical
 *  优先）。main_config 是 agent_config 的历史别名（agent_config 优先读入），
 *  main_fallback_configs 与历史 main_config 主配置配对（agent 槽兼容别名）。
 *  其余角色槽无别名。 */
export const ROLE_CONFIG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  agent_config: ['main_config'],
  agent_fallback_configs: ['main_fallback_configs'],
};

/** 角色名（含旧 main 等未知/None）归一 agent：兜底槽语义，防拼写静默换槽。 */
function normalize_role(role: string | null | undefined): string {
  return typeof role === 'string' && (MODEL_ROLES as readonly string[]).includes(role)
    ? role
    : DEFAULT_ROLE;
}

/** 角色槽名 → 模型配置键（`{role}_config`；未知/None 归一 agent 后取键）。
 *  main 等旧挡位名归一 agent_config，是挡位 → 角色迁移期的主要入口。 */
export function role_config_key(role: string | null | undefined): string {
  return `${normalize_role(role)}_config`;
}

/** 非空 record 才算该槽「已配置」（显式空 {} 与缺失同视为未配置 → 回落）。 */
function nonempty_record(value: unknown): JsonRecord | null {
  return isRecord(value) && Object.keys(value).length > 0 ? (value as JsonRecord) : null;
}

/** 备用链声明 → 有序配置清单（非 dict 项属声明噪音，忽略）。 */
function record_list(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord) as JsonRecord[];
}

/** 角色配置键候选（canonical + 兼容别名）；备用链键候选同理。 */
function config_keys(role: string): readonly string[] {
  const canonical = role_config_key(role);
  const aliases = ROLE_CONFIG_ALIASES[canonical];
  return aliases ? [canonical, ...aliases] : [canonical];
}

function fallback_keys(role: string): readonly string[] {
  const canonical = `${role}_fallback_configs`;
  const aliases = ROLE_CONFIG_ALIASES[canonical];
  return aliases ? [canonical, ...aliases] : [canonical];
}

/**
 * 从用户模型配置解析指定角色槽的配置形态（纯函数）。
 *
 * 读取顺序：
 * - 主配置 = 候选键中首个非空 record（agent 槽候选 agent_config/main_config，
 *   其余槽仅 `{role}_config`）；
 * - 备用列表 = 顶层 `{role}_fallback_configs`，缺失时兼容历史嵌套
 *   config["fallback_configs"]（取自主配置命中的那条 record）；
 * - 功能槽主配置缺失或显式空 {} → 回落 agent 槽（source_role='agent'、
 *   fallback=true，配置/备用链随 agent 槽解析）；agent 槽自身无配置 →
 *   config=null（调用方按无配置处理，不抛错）。
 */
export class RoleModelConfig {
  /** 请求角色（已归一：未知/None → agent）。 */
  readonly role: string;
  /** 生效主配置（null = 该槽与兜底槽均未配置）。 */
  readonly config: JsonRecord | null;
  /** 生效备用链（随 config 所属槽的备用键解析）。 */
  readonly fallbacks: readonly JsonRecord[];
  /** 配置实际来源槽名：功能槽自身有配置 = 自身；经回落 = agent。 */
  readonly source_role: string;
  /** 是否经 agent 槽回落（true = 请求功能槽未配置，显式回落、可观测不静默）。 */
  readonly fallback: boolean;

  constructor(init: {
    role: string;
    config: JsonRecord | null;
    fallbacks?: readonly JsonRecord[];
    source_role?: string;
    fallback?: boolean;
  }) {
    this.role = init.role;
    this.config = init.config;
    this.fallbacks = init.fallbacks ? [...init.fallbacks] : [];
    this.source_role = init.source_role ?? init.role;
    this.fallback = init.fallback ?? false;
  }
}

/** 解析指定角色槽的模型配置形态（纯函数；agent 槽永不标记回落）。 */
export function resolve_role_model(
  model_config: JsonRecord | null | undefined,
  role: string | null | undefined,
): RoleModelConfig {
  const norm = normalize_role(role);
  const cfgMap: JsonRecord = model_config ?? {};
  const primary = read_slot(cfgMap, config_keys(norm), fallback_keys(norm));
  if (norm === DEFAULT_ROLE || primary.config !== null) {
    return new RoleModelConfig({
      role: norm,
      config: primary.config,
      fallbacks: primary.fallbacks,
      source_role: norm,
      fallback: false,
    });
  }
  // 功能槽未配置（缺失或显式空 {}）→ 显式回落 agent 兜底槽
  const agent = resolve_role_model(model_config, DEFAULT_ROLE);
  return new RoleModelConfig({
    role: norm,
    config: agent.config,
    fallbacks: agent.fallbacks,
    source_role: DEFAULT_ROLE,
    fallback: true,
  });
}

/** 单槽读取结果：主配置（非空 record 或 null）+ 该槽备用链。 */
interface SlotRead {
  config: JsonRecord | null;
  fallbacks: readonly JsonRecord[];
}

function read_slot(
  cfgMap: JsonRecord,
  configKeys: readonly string[],
  fallbackKeys: readonly string[],
): SlotRead {
  let primary: JsonRecord | null = null;
  for (const key of configKeys) {
    primary = nonempty_record(cfgMap[key]);
    if (primary !== null) break;
  }
  if (primary === null) return { config: null, fallbacks: [] };
  let fallbacks: readonly JsonRecord[] = [];
  let top: unknown = undefined;
  for (const key of fallbackKeys) {
    const value = cfgMap[key];
    if (value !== undefined && value !== null) {
      top = value;
      break;
    }
  }
  if (top !== undefined) {
    fallbacks = record_list(top);
  } else {
    fallbacks = record_list(primary['fallback_configs']);
  }
  return { config: primary, fallbacks };
}

/** 链装配结果：ModelChain 的 configs 观察面（主配置在前，备用随后；类型不出模块）。 */
export interface RoleModelChain {
  readonly configs: readonly JsonRecord[];
}

/**
 * 按角色槽构建模型链（主配置 + 该槽备用链）；configs 全缺 → null。
 * 请求功能槽未配置时 = agent 配置 + agent 备用链（回落链）；agent 亦无配置
 * 返回 null（调用方按配置缺失兜底）。create/retry 为 llm 层 seam（仅保留
 * 注入面，暂不消费）。
 */
export function build_role_model_chain(
  model_config: JsonRecord | null | undefined,
  role: string | null | undefined = null,
  options: { create?: (config: JsonRecord) => unknown; retry?: unknown } = {},
): RoleModelChain | null {
  void options;
  const resolved = resolve_role_model(model_config, role);
  if (resolved.config === null) return null;
  return { configs: [resolved.config, ...resolved.fallbacks] };
}

/** 角色槽调用统计条目（结构化快照；via_fallback = 该用途经 agent 槽回落）。 */
export interface RoleCallStat {
  readonly role: string;
  readonly via_fallback: boolean;
  readonly count: number;
}

/** 角色调用观测标签（'role' 或回落 'role→agent'；供统计/审计/指标键名）。 */
export function role_call_label(role: string | null | undefined, via_fallback: boolean): string {
  const norm = normalize_role(role);
  return via_fallback ? `${norm}→${DEFAULT_ROLE}` : norm;
}

/** 角色槽调用统计钩子：按用途角色累加 LLM 调用次数，供回合级观测。 */
export class RoleModelStats {
  private counts = new Map<string, { role: string; via_fallback: boolean; count: number }>();

  /** 累加一次（或多次）某用途角色的调用数；未知角色归一 agent，非正计数忽略。
   *  via_fallback = true 标记「请求功能槽未配置、经 agent 槽回落」的调用
   *  （随 RoleModelConfig.fallback 填报，回落可观测不静默）。 */
  record(
    role: string | null | undefined,
    opts: { via_fallback?: boolean } = {},
    count = 1,
  ): void {
    const n = Math.trunc(count);
    if (n <= 0) return;
    const norm = normalize_role(role);
    const via = opts.via_fallback ?? false;
    const key = role_call_label(norm, via);
    const entry = this.counts.get(key) ?? { role: norm, via_fallback: via, count: 0 };
    entry.count += n;
    this.counts.set(key, entry);
  }

  /** 当前计数快照（结构化条目数组；插入序稳定，未调用过的槽不出现）。 */
  snapshot(): RoleCallStat[] {
    return [...this.counts.values()].map((entry) => ({
      role: entry.role,
      via_fallback: entry.via_fallback,
      count: entry.count,
    }));
  }

  /** 清零（新回合复用实例时调用）。 */
  reset(): void {
    this.counts.clear();
  }

  /** 合并另一实例的计数（+= 语义；嵌套图/子图回流场景汇总），返回自身。 */
  merge(other: RoleModelStats): this {
    for (const entry of other.snapshot()) {
      this.record(entry.role, { via_fallback: entry.via_fallback }, entry.count);
    }
    return this;
  }
}
