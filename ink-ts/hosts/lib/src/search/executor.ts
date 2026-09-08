/**
 * web_search host 注入：受控 fetch/http 执行体（引擎 web_search 端点消费）。
 *
 * 语义：引擎 web_search 端点把 ['search', query] 提取为操作，host 注册
 * 本执行体完成真实检索（provider 端点 → HTTP → 结果文本）。安全边界：
 * - provider 域名白名单（allow_domains 过滤，越界 fail-closed 拒绝）；
 * - provider 密钥只经内存 keys store 取用（不落盘、不进 args/审计）；
 * - 出网经注入 fetch 执行体（默认全局 fetch；测试注入桩），失败分型为
 *   WebSearchError（network/http_status/timeout/unknown_provider/denied）。
 * 结果文本化供 LLM 消费（结构化到文本，不把原始 JSON 泄给模型上下文）。
 */

import { hostAllowed } from '../exec/envelope.js';
import type { SearchKeysStore } from './keys.js';

/** 检索失败分型（code 供引擎 failure_reason 归类）。 */
export class WebSearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebSearchError';
    this.code = code;
  }
}

/** fetch 形状（与 host embedder remote 同构；测试注入桩）。 */
export type SearchFetch = (url: string, init: RequestInit) => Promise<Response>;

/** 结果条目（provider JSON 归一后的面）。 */
export interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

/** 单个检索条目渲染为文本行。 */
export function renderSearchResults(items: readonly SearchResultItem[]): string {
  if (items.length === 0) return '（无检索结果）';
  return items
    .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}${item.snippet ? `\n   ${item.snippet}` : ''}`)
    .join('\n');
}

/** 取数工具：按 dotted 路径从 JSON 取值。 */
function pathGet(root: unknown, dotted: string): unknown {
  let cur: unknown = root;
  for (const segment of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[segment];
    else return undefined;
  }
  return cur;
}

function firstString(item: unknown, keys: readonly string[]): string {
  if (typeof item !== 'object' || item === null) return '';
  const record = item as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** 归一结果数组（空/缺失 = 空列表）。 */
export function normalizeResults(raw: unknown, itemPath: string): SearchResultItem[] {
  const list = pathGet(raw, itemPath);
  if (!Array.isArray(list)) return [];
  const out: SearchResultItem[] = [];
  for (const item of list) {
    const title = firstString(item, ['name', 'title']);
    const url = firstString(item, ['url']);
    const snippet = firstString(item, ['snippet', 'text', 'content', 'summary']);
    if (title === '' && url === '') continue;
    out.push({ title: title || url, url, snippet: snippet || undefined });
  }
  return out;
}

/** 检索 provider 定义（host 常量表；测试可注入 extra）。 */
export interface SearchProviderDef {
  host: string;
  method: 'GET' | 'POST';
  url: string;
  headers: (apiKey: string) => Record<string, string>;
  body?: (query: string, apiKey: string) => string;
  /** JSON 结果数组路径（dotted）；无匹配 = 空结果集。 */
  itemPath: string;
}

/** 内置 provider 端点表（主机域名 + 请求形态 + 结果结构路径）。 */
export const SEARCH_PROVIDERS: Record<string, SearchProviderDef> = {
  bing: {
    host: 'api.bing.microsoft.com',
    method: 'GET',
    url: 'https://api.bing.microsoft.com/v7.0/search',
    headers: (key) => ({ 'Ocp-Apim-Subscription-Key': key }),
    itemPath: 'webPages.value',
  },
  bocha: {
    host: 'api.bochaai.com',
    method: 'POST',
    url: 'https://api.bochaai.com/v1/web-search',
    headers: () => ({ 'content-type': 'application/json' }),
    body: (query) => JSON.stringify({ query, count: 5 }),
    itemPath: 'data.web_results',
  },
  exa: {
    host: 'api.exa.ai',
    method: 'POST',
    url: 'https://api.exa.ai/search',
    headers: (key) => ({ 'x-api-key': key, 'content-type': 'application/json' }),
    body: (query) => JSON.stringify({ query, numResults: 5 }),
    itemPath: 'results',
  },
};

export interface WebSearchExecutorDeps {
  keys: SearchKeysStore;
  /** 出网执行体（缺省全局 fetch；测试注入桩）。 */
  fetchImpl?: SearchFetch;
  /** 放行域名（缺省 = 内置 provider 主机全集；越界 fail-closed）。 */
  allowDomains?: readonly string[];
  /** 额外 provider（测试注入自定义端点；与内置同名覆盖）。 */
  providers?: Record<string, SearchProviderDef>;
  /** 单次检索超时（秒；缺省 20）。 */
  timeoutSecs?: number;
  /** 缺省 provider（args 未指定时；缺省 bing）。 */
  defaultProvider?: string;
}

/** 受控 web_search 执行体工厂（引擎 DeclarativeExecutor 形态）。 */
export function makeWebSearchExecutor(
  deps: WebSearchExecutorDeps,
): (
  ctx: unknown,
  definition: { meta?: Record<string, unknown> } | null,
  args: Record<string, unknown>,
  approval?: unknown,
) => Promise<string> {
  const fetchImpl: SearchFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const providers = { ...SEARCH_PROVIDERS, ...(deps.providers ?? {}) };
  const allowDomains = [...(deps.allowDomains ?? Object.values(providers).map((p) => p.host))];
  const timeoutSecs = deps.timeoutSecs ?? 20;
  const defaultProvider = deps.defaultProvider ?? 'bing';
  return async (_ctx, definition, args, _approval): Promise<string> => {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
    if (query === '') throw new WebSearchError('empty_query', 'web_search 缺 query');
    const providerName =
      (typeof args['provider'] === 'string' && args['provider'].trim() !== ''
        ? args['provider'].trim()
        : undefined) ??
      (typeof definition?.meta?.['default_provider'] === 'string'
        ? (definition.meta['default_provider'] as string)
        : undefined) ??
      defaultProvider;
    const provider = providers[providerName];
    if (provider === undefined) {
      throw new WebSearchError(
        'unknown_provider',
        `web_search 未知 provider: ${providerName}（内置: ${Object.keys(providers).join(', ')}）`,
      );
    }
    if (!hostAllowed(allowDomains, provider.host)) {
      throw new WebSearchError(
        'denied',
        `web_search provider 域名不在放行白名单内: ${provider.host}`,
      );
    }
    const apiKey = deps.keys.raw(providerName) ?? '';
    if (apiKey === '') {
      throw new WebSearchError(
        'missing_key',
        `web_search provider ${providerName} 未配置密钥（search.keys.set）`,
      );
    }
    const url = new URL(provider.url);
    url.searchParams.set('q', query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000);
    try {
      const init: RequestInit = {
        method: provider.method,
        headers: provider.headers(apiKey),
        signal: controller.signal,
      };
      if (provider.method === 'POST') {
        init.body = provider.body?.(query, apiKey);
      }
      const response = await fetchImpl(url.toString(), init);
      if (!response.ok) {
        throw new WebSearchError(
          'http_status',
          `web_search 上游返回 ${response.status} ${response.statusText}`,
        );
      }
      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      let data: unknown = null;
      if (contentType.includes('application/json')) {
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          data = null;
        }
      }
      return renderSearchResults(normalizeResults(data, provider.itemPath));
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      const aborted = typeof DOMException === 'function' && error instanceof DOMException && error.name === 'AbortError';
      throw new WebSearchError(
        aborted ? 'timeout' : 'network',
        `web_search 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
