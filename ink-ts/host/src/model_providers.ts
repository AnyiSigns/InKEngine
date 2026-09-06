/**
 * 厂商模型域（providers → agent/router 角色槽派生）——宿主侧纯函数。
 *
 * 数据模型（与设置页「模型」节同一形态，落 model_config 透传键）：
 * - providers：厂商清单（端点/密钥/协议 + 该厂商下已添加模型清单 models，
 *   模型项为 string model_id 或 { model_id, context_window? }）；
 * - agent_pick / router_pick：{ provider_id, model_id } 槽指派（agent =
 *   对话模型，由对话输入框选；router = 功能槽（蒸馏/决策），由设置页选）。
 *
 * 引擎只消费角色槽端点键（agent_config/router_config，模型键取
 * `{role}_config`）；本模块在 apply 时按 pick 从 providers 派生端点写入
 * 角色槽，保证「pick 变更即换角色槽、重启后派生一致」。未显式 pick 的
 * 派生缺省：agent 回落首个厂商的首个模型；router 不派生（功能槽缺省回落
 * agent 语义归引擎）。厂商/模型被删后指向它的 pick 失效 → 该槽不派生
 * （agent 再由缺省兜底），可观测不静默。
 *
 * 端点协议：provider.adapter（或 protocol）即 canonical 协议名
 * （openai_compatible/anthropic_messages/…，厂商只是端点配置）。
 */

import { maskKey } from './search/keys.js';

export type RoleName = 'agent' | 'router';

export interface ProviderPick {
  provider_id: string;
  model_id: string;
}

export interface ProviderRecord {
  provider_id: string;
  base_url: string;
  adapter: string;
  label?: string;
  vendor?: string;
  api_key?: string;
  models: Array<string | { model_id?: unknown; context_window?: number }>;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 模型清单 → 有序 model_id 列表（字符串项或 {model_id} 对象项）。 */
export function providerModelIds(provider: ProviderRecord): string[] {
  const ids: string[] = [];
  for (const entry of provider.models) {
    if (typeof entry === 'string') {
      if (entry !== '') ids.push(entry);
    } else if (isRecord(entry) && typeof entry['model_id'] === 'string' && entry['model_id'] !== '') {
      ids.push(entry['model_id']);
    }
  }
  return ids;
}

/** 判定记录是否为「厂商形态」（带端点 + 模型清单）。 */
export function isProviderRecord(value: unknown): value is Record<string, unknown> & { models: unknown[] } {
  return (
    isRecord(value)
    && typeof value['provider_id'] === 'string'
    && value['provider_id'] !== ''
    && Array.isArray(value['models'])
    && typeof value['base_url'] === 'string'
  );
}

export function asProvider(value: unknown): ProviderRecord | null {
  if (!isProviderRecord(value)) return null;
  const provider = value as unknown as ProviderRecord;
  const adapter =
    typeof provider['adapter'] === 'string' && provider['adapter'] !== ''
      ? provider['adapter']
      : (typeof provider['protocol'] === 'string' ? provider['protocol'] : '');
  return { ...provider, adapter };
}

/** pick → 端点配置（厂商/模型缺失 = null）。 */
export function endpointForPick(
  providers: readonly ProviderRecord[],
  pick: ProviderPick | null,
): Record<string, unknown> | null {
  if (pick === null || pick === undefined) return null;
  const provider = providers.find((p) => p.provider_id === pick.provider_id);
  if (provider === null || provider === undefined) return null;
  const models = providerModelIds(provider);
  if (!models.includes(pick.model_id)) return null;
  const endpoint: Record<string, unknown> = {
    base_url: provider.base_url,
    model_id: pick.model_id,
  };
  if (provider.adapter !== '') {
    endpoint['protocol'] = provider.adapter;
    endpoint['adapter'] = provider.adapter;
  }
  if (typeof provider.api_key === 'string' && provider.api_key !== '') {
    endpoint['api_key'] = provider.api_key;
  }
  return endpoint;
}

/** 缺省 agent pick：首个厂商的首个模型（无可选 = null）。 */
export function defaultAgentPick(providers: readonly ProviderRecord[]): ProviderPick | null {
  const first = providers[0];
  if (first === undefined) return null;
  const models = providerModelIds(first);
  if (models.length === 0) return null;
  return { provider_id: first.provider_id, model_id: models[0]! };
}

/** pick 判定：同一 厂商+模型 才算相等（undefined/null 同视为未指派）。 */
export function samePick(
  a: ProviderPick | null | undefined,
  b: ProviderPick | null | undefined,
): boolean {
  const an = a === null || a === undefined ? null : a;
  const bn = b === null || b === undefined ? null : b;
  if (an === null || bn === null) return an === bn;
  return an.provider_id === bn.provider_id && an.model_id === bn.model_id;
}

/** 掩码回传判定（api_key = 既有明文掩码 = 未变更）。 */
export function maskedEqualsPlain(masked: unknown, plain: string | undefined): boolean {
  return typeof masked === 'string' && plain !== undefined && masked === maskKey(plain);
}

/**
 * 按 provider_id 逐厂商合并（整表写语义）：api_key 缺失/掩码回传沿用
 * 既有明文；厂商排序 = 入参顺序（当前厂商置前由 UI 保证）。入参厂商
 * 缺席的既有厂商保留。
 */
export function mergeProviders(
  prev: readonly ProviderRecord[],
  incoming: readonly ProviderRecord[],
): ProviderRecord[] {
  const next = [...incoming];
  const prevById = new Map(prev.map((p) => [p.provider_id, p]));
  return next.map((provider) => {
    const prior = prevById.get(provider.provider_id);
    if (prior === undefined) return provider;
    const apiKey = provider.api_key;
    const priorKey = prior.api_key;
    if (apiKey === undefined || apiKey === '') {
      return { ...provider, api_key: priorKey };
    }
    if (priorKey !== undefined && maskedEqualsPlain(apiKey, priorKey)) {
      return { ...provider, api_key: priorKey };
    }
    return provider;
  });
}

/**
 * 厂商面应用产物：输入含 providers 时按 picks 派生角色槽端点并整档合并。
 * 返回 null 表示输入不含 providers（调用方走既有角色槽直写合并语义）。
 */
export function applyProvidersConfig(
  prevDoc: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Array.isArray(input['providers'])) return null;
  const prevProviders = Array.isArray(prevDoc['providers'])
    ? (prevDoc['providers'] as unknown[]).map(asProvider).filter((p): p is ProviderRecord => p !== null)
    : [];
  const inProviders = (input['providers'] as unknown[])
    .map(asProvider)
    .filter((p): p is ProviderRecord => p !== null);
  const providers = mergeProviders(prevProviders, inProviders);
  if (providers.length === 0) {
    // 清空厂商 = 清空派生槽（含 pick），角色槽随厂商面整体移除
    const cleaned: Record<string, unknown> = { ...prevDoc, providers: [] };
    delete cleaned['agent_config'];
    delete cleaned['router_config'];
    delete cleaned['agent_pick'];
    delete cleaned['router_pick'];
    return cleaned;
  }

  const pickFrom = (raw: unknown): ProviderPick | null => {
    if (!isRecord(raw)) return null;
    const provider_id = raw['provider_id'];
    const model_id = raw['model_id'];
    if (typeof provider_id !== 'string' || typeof model_id !== 'string') return null;
    const provider = providers.find((p) => p.provider_id === provider_id);
    if (provider === undefined) return null;
    return providerModelIds(provider).includes(model_id)
      ? { provider_id, model_id }
      : null;
  };

  // agent：入参 pick > 既有 pick > 缺省首厂商首模型；失效则缺省兜底
  const prevAgent = isRecord(prevDoc['agent_pick'])
    ? pickFrom(prevDoc['agent_pick'])
    : null;
  const agentPick = pickFrom(input['agent_pick']) ?? prevAgent ?? defaultAgentPick(providers);
  const routerPick =
    pickFrom(input['router_pick'])
    ?? (isRecord(prevDoc['router_pick']) ? pickFrom(prevDoc['router_pick']) : null);

  const out: Record<string, unknown> = {
    ...prevDoc,
    providers,
  };
  if (agentPick !== null) out['agent_pick'] = agentPick;
  else delete out['agent_pick'];
  if (routerPick !== null) out['router_pick'] = routerPick;
  else delete out['router_pick'];
  const agentEndpoint = endpointForPick(providers, agentPick);
  const routerEndpoint = endpointForPick(providers, routerPick);
  if (agentEndpoint !== null) out['agent_config'] = agentEndpoint;
  else delete out['agent_config'];
  if (routerEndpoint !== null) out['router_config'] = routerEndpoint;
  else delete out['router_config'];
  // 角色槽备用链键在厂商面下不派生；输入侧也仅接受角色槽主键（显式直写
  // 走既有槽直写合并语义，不经本模块）
  delete out['agent_fallback_configs'];
  delete out['router_fallback_configs'];
  return out;
}
