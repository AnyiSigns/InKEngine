/**
 * host 运行配置读取（L4 composition root 的数据入口）。
 *
 * 只做「读配置 + 校验形状」，不做任何装配/接线（那是 host.ts/recipe.ts 的
 * 事）。配置形态与 CODING §8 措辞对齐：模型端点按协议、按角色槽三键
 * {agent_config, router_config, audit_config} + `{role}_fallback_configs`
 * 备用链（main_config 等别名兼容由引擎 model_roles 解析，本层不复制回落
 * 语义）；厂商只是端点配置（协议决定适配器，见 D7）。审批姿态 fail-closed：
 * autoApprove 缺省 false，仅显式配置才放行。
 *
 * 键形态：文件/对象输入采用 RoleEndpoint 各槽形态；环境覆盖走 INK_* 前缀
 * （见 ENV_KEYS）。storage_uri 与 data/events/seed 目录为宿主运行路径。
 */

import path from 'node:path';

/** 三个内置协议（引擎注册表 canonical 适配器名；厂商仅是端点配置）。 */
export const LLM_PROTOCOLS = [
  'openai_compatible',
  'openai_responses',
  'anthropic_messages',
] as const;

export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

/** 单模型端点配置（主配置与备用链同一形态）。 */
export interface RoleEndpointConfig {
  /** 协议（三内置协议之一；缺省按 adapter 透传——厂商别名/自定义注册名）。 */
  protocol?: LlmProtocol | string;
  /** 显式注册适配器名（优先级最高；缺省回落 protocol）。 */
  adapter?: string;
  base_url: string;
  api_key?: string | null;
  model_id: string;
  temperature?: number | null;
  max_tokens?: number | null;
  request_timeout?: number | null;
}

/** 角色槽模型配置（键名 = CODING §8 {role}_config / {role}_fallback_configs）。 */
export interface ModelConfigInput {
  agent_config?: RoleEndpointConfig;
  agent_fallback_configs?: RoleEndpointConfig[];
  router_config?: RoleEndpointConfig;
  router_fallback_configs?: RoleEndpointConfig[];
  audit_config?: RoleEndpointConfig;
  audit_fallback_configs?: RoleEndpointConfig[];
}

/** host 配置输入（JSON 文件 / 对象 / 环境覆盖）。 */
export interface HostConfigInput {
  storage_uri?: string;
  model_config?: ModelConfigInput | null;
  /** 审批姿态：fail-closed 缺省 false；true = 全量显式放行（仅显式配置）。 */
  autoApprove?: boolean;
  /** 审批超时秒数（null = 不限时；由 DefaultInterruptPolicy 语义消费）。 */
  approval_timeout?: number | null;
  data_dir?: string;
  events_dir?: string;
  seed_dir?: string;
}

/** 解析后的运行配置（目录已定稿；model_config 为角色槽 record 形态）。 */
export interface ResolvedHostConfig {
  storage_uri: string;
  /** 原始角色槽形态（resolve_role_model 直接消费；无第二套解析语义）。 */
  model_config: Record<string, unknown>;
  autoApprove: boolean;
  approval_timeout: number | null;
  data_dir: string;
  events_dir: string;
  seed_dir: string;
}

/** 配置错误（形状非法显式报错，不静默吞）。 */
export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostConfigError';
  }
}

/** 环境覆盖键（INK_* 前缀；路径/布尔直读，模型槽不经环境——保持单点形状）。 */
export const ENV_KEYS = {
  storageUri: 'INK_STORAGE_URI',
  autoApprove: 'INK_AUTO_APPROVE',
  dataDir: 'INK_DATA_DIR',
  eventsDir: 'INK_EVENTS_DIR',
  seedDir: 'INK_SEED_DIR',
} as const;

/** 角色槽主配置键（CODING §8；别名/回落归引擎，本层不复制）。 */
export const ROLE_SLOT_KEYS = [
  'agent_config',
  'router_config',
  'audit_config',
] as const;

/** 缺省存储连接串（内存后端；持久化需显式 sqlite:///path）。 */
export const DEFAULT_STORAGE_URI = 'memory://';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 规范化单个端点配置：协议 → canonical 适配器名；未知协议显式报错。 */
export function normalize_endpoint(raw: unknown, where: string): RoleEndpointConfig {
  if (!isRecord(raw)) {
    throw new HostConfigError(`${where} 期望对象形态，收到 ${String(raw)}`);
  }
  if (typeof raw['base_url'] !== 'string' || raw['base_url'] === '') {
    throw new HostConfigError(`${where} 缺 base_url`);
  }
  if (typeof raw['model_id'] !== 'string' || raw['model_id'] === '') {
    throw new HostConfigError(`${where} 缺 model_id`);
  }
  const protocol = raw['protocol'];
  const adapterRaw = raw['adapter'];
  if (protocol !== undefined && protocol !== null) {
    const name = String(protocol);
    if (!(LLM_PROTOCOLS as readonly string[]).includes(name)) {
      throw new HostConfigError(
        `${where} 未知协议 '${name}'（内置: ${LLM_PROTOCOLS.join(', ')}）`,
      );
    }
  }
  const result: RoleEndpointConfig = {
    base_url: raw['base_url'],
    model_id: raw['model_id'],
    protocol: protocol as LlmProtocol | string | undefined,
  };
  if (adapterRaw !== undefined && adapterRaw !== null) {
    result.adapter = String(adapterRaw);
  } else if (protocol !== undefined && protocol !== null) {
    // 协议即适配器名（内置三协议与注册表 canonical 同名；厂商只是端点）
    result.adapter = String(protocol);
  } else {
    throw new HostConfigError(`${where} 须声明 protocol 或 adapter（无法选适配器）`);
  }
  for (const key of [
    'api_key',
    'temperature',
    'max_tokens',
    'request_timeout',
  ] as const) {
    const value = raw[key];
    if (value !== undefined && value !== null) result[key] = value as never;
  }
  return result;
}

/** 布尔环境直读（'1'/'true'/'yes' 归一 true；其余 false——fail-closed 方向）。 */
function envBool(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === '') return null;
  return /^(1|true|yes|on)$/i.test(raw);
}

/** 解析 model_config 输入 → 角色槽 record 形态（校验形状，键名透传）。 */
export function normalize_model_config(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (!isRecord(input)) {
    throw new HostConfigError(`model_config 期望对象形态，收到 ${String(input)}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const isSlot = (ROLE_SLOT_KEYS as readonly string[]).includes(key);
    const isFallbacks = /^[a-z]+_fallback_configs$/.test(key);
    if (value === undefined || value === null) continue;
    if (isSlot) {
      out[key] = normalize_endpoint(value, `model_config.${key}`);
    } else if (isFallbacks) {
      if (!Array.isArray(value)) {
        throw new HostConfigError(`model_config.${key} 期望列表（备用链）`);
      }
      out[key] = value.map((entry, index) =>
        normalize_endpoint(entry, `model_config.${key}[${index}]`),
      );
    } else {
      // 未知角色槽键透传（引擎 model_roles 宽容未知键；扩展槽不走本层白名单）
      out[key] = value;
    }
  }
  return out;
}

/** 目录字段解析：events 缺省落在 data_dir/events（D9 事件落文件出口）。 */
function resolve_dirs(
  input: HostConfigInput,
  env: NodeJS.ProcessEnv,
  dataFallback: string,
): { data_dir: string; events_dir: string; seed_dir: string } {
  const data_dir = env[ENV_KEYS.dataDir] ?? input.data_dir ?? dataFallback;
  const events_dir = env[ENV_KEYS.eventsDir] ?? input.events_dir ?? path.join(data_dir, 'events');
  const seed_dir = env[ENV_KEYS.seedDir] ?? input.seed_dir ?? '';
  return { data_dir, events_dir, seed_dir };
}

/**
 * 解析运行配置（输入 + 环境覆盖 → 定稿形态）。autoApprove 输入缺省 false
 * （fail-closed：显式 true 才放行；env INK_AUTO_APPROVE 为最后覆盖层）。
 */
export function resolve_host_config(
  input: HostConfigInput | null | undefined = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ResolvedHostConfig {
  const base = input ?? {};
  const storage_uri = env[ENV_KEYS.storageUri] ?? base.storage_uri ?? DEFAULT_STORAGE_URI;
  const autoApproveRaw = env[ENV_KEYS.autoApprove];
  const autoApprove =
    envBool(autoApproveRaw) ?? base.autoApprove ?? false;
  if (autoApproveRaw !== undefined && envBool(autoApproveRaw) === null && autoApproveRaw !== '') {
    throw new HostConfigError(`INK_AUTO_APPROVE 非布尔取值: '${autoApproveRaw}'`);
  }
  const dirs = resolve_dirs(base, env, path.join(cwd, '.ink-host'));
  return {
    storage_uri,
    model_config: normalize_model_config(base.model_config ?? null),
    autoApprove,
    approval_timeout: base.approval_timeout ?? null,
    ...dirs,
  };
}
