/**
 * web_search host 注入：密钥存取掩码 + 受控 fetch 执行体（allow_domains 过滤）。
 */

import { describe, expect, it } from 'vitest';

import { SearchKeysStore } from '../../src/search/keys.js';
import { makeWebSearchExecutor } from '../../src/search/executor.js';
import type { SearchFetch, SearchProviderDef } from '../../src/search/executor.js';

function jsonFetch(status: number, body: unknown): SearchFetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const STUB_PROVIDERS: Record<string, SearchProviderDef> = {
  stub: {
    host: 'stub.local',
    method: 'GET',
    url: 'https://stub.local/search',
    headers: () => ({ 'x-key': '1' }),
    itemPath: 'results',
  },
};

function ctx(): unknown {
  return {};
}
const NO_DEF = null;

describe('SearchKeysStore', () => {
  it('密钥不落明文：只回显掩码；raw 仅执行体面可用', () => {
    const store = new SearchKeysStore();
    store.set('bing', 'secret-key-1234567890');
    expect(store.raw('bing')).toBe('secret-key-1234567890');
    const masked = store.masked()['bing'] ?? '';
    expect(masked).not.toContain('secret-key-1234567890');
    expect(masked.endsWith('****')).toBe(true);
    expect(store.count()).toBe(1);
  });

  it('空 provider/密钥拒绝写入', () => {
    const store = new SearchKeysStore();
    expect(() => store.set('', 'k')).toThrow();
    expect(() => store.set('bing', '  ')).toThrow();
  });
});

describe('makeWebSearchExecutor：allow_domains 过滤 + 失败分型', () => {
  it('放行域内检索成功（stub fetch 注入；结果文本化）', async () => {
    const store = new SearchKeysStore();
    store.set('stub', 'k');
    const executor = makeWebSearchExecutor({
      keys: store,
      providers: STUB_PROVIDERS,
      allowDomains: ['stub.local'],
      fetchImpl: jsonFetch(200, {
        results: [{ title: 'TS 引擎', url: 'https://a/x', snippet: '描述' }],
      }),
    });
    const text = await executor(ctx(), NO_DEF, { query: 'typescript', provider: 'stub' });
    expect(text).toContain('TS 引擎');
    expect(text).toContain('https://a/x');
    expect(text).toContain('描述');
  });

  it('域外 provider 域名 = denied（fail-closed）', async () => {
    const store = new SearchKeysStore();
    store.set('stub', 'k');
    const executor = makeWebSearchExecutor({
      keys: store,
      providers: STUB_PROVIDERS,
      allowDomains: ['other.local'],
      fetchImpl: jsonFetch(200, { results: [] }),
    });
    await expect(executor(ctx(), NO_DEF, { query: 'q', provider: 'stub' })).rejects.toMatchObject({
      name: 'WebSearchError',
      code: 'denied',
    });
  });

  it('未知 provider / 缺密钥 / 空 query = 结构化错误', async () => {
    const store = new SearchKeysStore();
    const executor = makeWebSearchExecutor({ keys: store, providers: STUB_PROVIDERS, fetchImpl: jsonFetch(200, {}) });
    await expect(executor(ctx(), NO_DEF, { query: 'q', provider: 'nope' })).rejects.toMatchObject({ code: 'unknown_provider' });
    await expect(executor(ctx(), NO_DEF, { query: 'q', provider: 'stub' })).rejects.toMatchObject({ code: 'missing_key' });
    await expect(executor(ctx(), NO_DEF, {})).rejects.toMatchObject({ code: 'empty_query' });
  });

  it('上游非 2xx = http_status 分型', async () => {
    const store = new SearchKeysStore();
    store.set('stub', 'k');
    const executor = makeWebSearchExecutor({
      keys: store,
      providers: STUB_PROVIDERS,
      fetchImpl: jsonFetch(500, {}),
    });
    await expect(executor(ctx(), NO_DEF, { query: 'q', provider: 'stub' })).rejects.toMatchObject({
      code: 'http_status',
      message: expect.stringContaining('500'),
    });
  });
});
