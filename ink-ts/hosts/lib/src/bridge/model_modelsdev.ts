/**
 * models.dev 能力注册表（开源模型库，免鉴权）。
 *
 * GET https://models.dev/api.json → { [provider_id]: { models: { [model_id]: {...} } } }
 * 每模型含 reasoning 与 reasoning_options：
 *   { type: 'effort', values: ['low','medium','high','xhigh','max'] } → effort 档
 *   { type: 'toggle' }                                            → boolean 开关
 *   { type: 'budget', ... }                                       → budget 预算
 * 映射到引擎 base.ts 的 reasoning_style：effort/boolean/budget/none。
 *
 * 带进程内缓存（TTL），避免每次 model_archive.snapshot 重复拉全量；出网经注入
 * fetch（测试桩；缺省全局 fetch），12s 超时。厂商 /models 元数据未给具体档位时
 * 本注册表是最完整的能力真源（含 xhigh/max 等非标准档）。
 */

import type { ModelCapability, ModelCapabilityMap, CatalogFetch } from './model_catalog.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let cached: { at: number; map: ModelCapabilityMap } | null = null;

function mapOptions(reasoning: unknown, options: unknown): ModelCapability | null {
  const hasReasoning = reasoning === true || reasoning === 'true';
  if (!hasReasoning) return null;
  const list = Array.isArray(options) ? options : [];
  let effortValues: string[] | undefined;
  let hasToggle = false;
  let hasBudget = false;
  for (const opt of list) {
    if (opt === null || typeof opt !== 'object') continue;
    const o = opt as Record<string, unknown>;
    if (o['type'] === 'effort' && Array.isArray(o['values'])) {
      effortValues = (o['values'] as unknown[]).filter((v): v is string => typeof v === 'string');
    } else if (o['type'] === 'toggle') {
      hasToggle = true;
    } else if (o['type'] === 'budget') {
      hasBudget = true;
    }
  }
  if (effortValues !== undefined && effortValues.length > 0) {
    return { reasoning: true, reasoning_style: 'effort', reasoning_efforts: effortValues };
  }
  if (hasBudget) return { reasoning: true, reasoning_style: 'budget' };
  if (hasToggle) return { reasoning: true, reasoning_style: 'boolean' };
  return { reasoning: true, reasoning_style: 'none' };
}

function parsePayload(payload: unknown): ModelCapabilityMap {
  const map: ModelCapabilityMap = {};
  if (payload === null || typeof payload !== 'object') return map;
  for (const provider of Object.values(payload as Record<string, unknown>)) {
    if (provider === null || typeof provider !== 'object') continue;
    const models = (provider as Record<string, unknown>)['models'];
    if (models === null || typeof models !== 'object') continue;
    for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object') continue;
      const cap = mapOptions((entry as Record<string, unknown>)['reasoning'], (entry as Record<string, unknown>)['reasoning_options']);
      if (cap !== null) map[modelId] = cap;
    }
  }
  return map;
}

const defaultFetch: CatalogFetch = async (url, init) => fetch(url, init);

/** 抓取并解析 models.dev 注册表（带缓存；失败 → 空 map，上层回退厂商/目录）。 */
export async function fetchModelsDevCatalog(
  fetchImpl: CatalogFetch = defaultFetch,
  now = Date.now(),
): Promise<ModelCapabilityMap> {
  if (cached !== null && now - cached.at < CACHE_TTL_MS) return cached.map;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12000);
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { method: 'GET', headers: { accept: 'application/json' }, signal: abort.signal });
    if (!response.ok) return cached?.map ?? {};
    const payload = await response.json();
    const map = parsePayload(payload);
    cached = { at: now, map };
    return map;
  } catch {
    return cached?.map ?? {};
  } finally {
    clearTimeout(timer);
  }
}

/** 测试用：清缓存。 */
export function clearModelsDevCache(): void {
  cached = null;
}

/** 能力查找：先按完整 model_id 精确匹配，再按「模型尾段」归一匹配（兼容
 *  裸 id vs provider/<id> 变体）。未命中 = undefined。 */
export function lookupModelsDevCapability(
  map: ModelCapabilityMap,
  modelId: string,
): ModelCapability | undefined {
  if (map[modelId] !== undefined) return map[modelId];
  const tail = modelId.split('/').pop()!.toLowerCase();
  if (tail === '') return undefined;
  for (const [key, cap] of Object.entries(map)) {
    const keyTail = key.split('/').pop()!.toLowerCase();
    if (keyTail === tail) return cap;
  }
  return undefined;
}

export type { ModelCapability };
