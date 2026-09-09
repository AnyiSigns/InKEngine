/**
 * model_catalog 能力抓取/映射测试：测的是「厂商 /models 元数据 → reasoning_style
 * mapping + 抓取失败回退 + 超时/网络错误不出网失败」——出网经注入桩，不真实联网。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  mapCapabilityFromModel,
  mapCatalogFromPayload,
  fetchModelCatalog,
  type CatalogFetch,
} from '../../src/bridge/model_catalog.js';

function jsonResponse(payload: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => payload };
}

describe('model_catalog 能力映射', () => {
  it('OpenRouter 风格：supported_parameters 含 reasoning_effort → effort 档位族', () => {
    const cap = mapCapabilityFromModel({
      id: 'deepseek/deepseek-v4-flash',
      supported_parameters: ['reasoning', 'reasoning_effort', 'web_search'],
      supported_reasoning_efforts: ['low', 'medium', 'high'],
    });
    expect(cap).toEqual({ reasoning: true, reasoning_style: 'effort', reasoning_efforts: ['low', 'medium', 'high'] });
  });

  it('OpenRouter 风格：含 enable_thinking → boolean 开关族', () => {
    const cap = mapCapabilityFromModel({ id: 'qwen/qwen3-max', supported_parameters: ['enable_thinking'] });
    expect(cap?.reasoning_style).toBe('boolean');
  });

  it('thinking/budget 参数 → budget 族', () => {
    const cap = mapCapabilityFromModel({ id: 'claude-4', supported_parameters: ['thinking'], thinking: { type: 'enabled', budget_tokens: 4096 } });
    expect(cap?.reasoning_style).toBe('budget');
  });

  it('reasoning=fixed 或无能力字段 → none / null', () => {
    expect(mapCapabilityFromModel({ id: 'deepseek-reasoner', reasoning: 'fixed' })?.reasoning_style).toBe('none');
    expect(mapCapabilityFromModel({ id: 'plain' })).toBeNull();
  });

  it('mapCatalogFromPayload 兼容 data[].id / models[] 并剔除无能力条目', () => {
    const catalog = mapCatalogFromPayload({
      data: [
        { id: 'a/b', supported_parameters: ['reasoning_effort'] },
        { id: 'c/d' },
      ],
    });
    expect(Object.keys(catalog)).toEqual(['a/b']);
    expect(catalog['a/b']?.reasoning_style).toBe('effort');
  });

  it('fetchModelCatalog：成功返回 catalog；非 2xx / 网络错误 → ok:false 空 catalog', async () => {
    const okFetch: CatalogFetch = vi.fn(async (url) => {
      expect(String(url)).toMatch(/\/models$/);
      return jsonResponse({ data: [{ id: 'x', supported_parameters: ['reasoning_effort'] }] });
    });
    expect((await fetchModelCatalog('https://gw.test/api', null, okFetch)).catalog['x']).toBeTruthy();

    const badFetch: CatalogFetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect((await fetchModelCatalog('https://gw.test/api', null, badFetch)).ok).toBe(false);
  });
});
