/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/model_catalog.ts 原样迁入（S3 命令逻辑下沉，
 * 语义零改）：model_archive.snapshot 能力增强真源（厂商 /models 元数据抓取）。
 */

/** 推理能力（与 model_archive.ArchiveRow 字段同形）。 */
export interface ModelCapability {
  reasoning?: boolean;
  reasoning_style?: 'effort' | 'boolean' | 'budget' | 'none';
  reasoning_efforts?: string[];
  reasoning_budget?: number[];
}

export type ModelCapabilityMap = Record<string, ModelCapability>;

/** fetch 实现形态（缺省 = 全局 fetch；测试注入桩）。 */
export interface CatalogFetch {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

const EFFORTS = ['off', 'low', 'medium', 'high'] as const;

function asEfforts(value: unknown): Array<'off' | 'low' | 'medium' | 'high'> | undefined {
  const list: Array<'off' | 'low' | 'medium' | 'high'> = [];
  const items = Array.isArray(value) ? value : value !== null && typeof value === 'object'
    ? Array.isArray((value as Record<string, unknown>)['efforts'])
      ? (value as Record<string, unknown>)['efforts'] as unknown[]
      : []
    : [];
  for (const item of items) {
    if (item === 'off' || item === 'low' || item === 'medium' || item === 'high') {
      list.push(item);
    }
  }
  return list.length > 0 ? list : undefined;
}

function firstEfforts(...sources: unknown[]): Array<'off' | 'low' | 'medium' | 'high'> | undefined {
  for (const src of sources) {
    const efforts = asEfforts(src);
    if (efforts !== undefined) return efforts;
  }
  return undefined;
}

function asBudgets(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    const budgets = value.filter((n): n is number => typeof n === 'number' && n > 0);
    return budgets.length > 0 ? budgets : undefined;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record['budgets'])) {
      const budgets = record['budgets'].filter((n): n is number => typeof n === 'number' && n > 0);
      return budgets.length > 0 ? budgets : undefined;
    }
  }
  return undefined;
}

/** 从单个模型元数据条目映射能力；无推理信息 = null。 */
export function mapCapabilityFromModel(entry: Record<string, unknown>): ModelCapability | null {
  const parameters = Array.isArray(entry['supported_parameters'])
    ? (entry['supported_parameters'] as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const thinking = entry['thinking'];
  const reasoning = entry['reasoning'];
  const hasEffortParam = parameters.includes('reasoning_effort');
  const hasThinkingParam = parameters.includes('thinking') || parameters.includes('budget_tokens');
  const hasEnableThinkingParam = parameters.includes('enable_thinking');

  const efforts = firstEfforts(entry['supported_reasoning_efforts'], entry['reasoning_efforts'], reasoning);

  if (hasEffortParam || (efforts !== undefined && !hasThinkingParam && !hasEnableThinkingParam)) {
    return { reasoning: true, reasoning_style: 'effort', reasoning_efforts: efforts };
  }
  if (hasThinkingParam || (thinking && typeof thinking === 'object')) {
    const budgets = asBudgets(thinking);
    return budgets !== undefined
      ? { reasoning: true, reasoning_style: 'budget', reasoning_budget: budgets }
      : { reasoning: true, reasoning_style: 'budget' };
  }
  if (hasEnableThinkingParam || (reasoning && (reasoning as Record<string, unknown>)['type'] === 'boolean')) {
    return { reasoning: true, reasoning_style: 'boolean' };
  }
  if (reasoning === true || reasoning === 'fixed') {
    return { reasoning: true, reasoning_style: 'none' };
  }
  return null;
}

/** 解析 /models 载荷（兼容 data[].id / models[]），产出 模型 id → 能力。 */
export function mapCatalogFromPayload(payload: unknown): ModelCapabilityMap {
  const catalog: ModelCapabilityMap = {};
  if (payload === null || typeof payload !== 'object') return catalog;
  const container = payload as Record<string, unknown>;
  const list = Array.isArray(container['data'])
    ? (container['data'] as unknown[])
    : Array.isArray(container['models'])
      ? (container['models'] as unknown[])
      : [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry['id'] === 'string' ? entry['id']
      : typeof entry['model_id'] === 'string' ? entry['model_id']
        : typeof entry['model'] === 'string' ? entry['model'] : null;
    if (id === null || id === '') continue;
    const capability = mapCapabilityFromModel(entry);
    if (capability !== null) catalog[id] = capability;
  }
  return catalog;
}

const defaultFetch: CatalogFetch = async (url, init) => fetch(url, init);

/** 抓取某 base_url 的 /models 并映射能力；失败 → { ok:false, catalog:{} }。 */
export async function fetchModelCatalog(
  base_url: string,
  api_key: string | null,
  fetchImpl: CatalogFetch = defaultFetch,
): Promise<{ ok: boolean; catalog: ModelCapabilityMap; error?: string }> {
  const url = `${base_url.replace(/\/+$/, '')}/models`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (api_key !== null && api_key !== '') {
      headers['authorization'] = `Bearer ${api_key}`;
    }
    const response = await fetchImpl(url, { method: 'GET', headers, signal: abort.signal });
    if (!response.ok) return { ok: false, catalog: {}, error: `http_${response.status}` };
    const payload = await response.json();
    return { ok: true, catalog: mapCatalogFromPayload(payload) };
  } catch (error) {
    const reason = error instanceof Error ? error.name : String(error);
    return { ok: false, catalog: {}, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
