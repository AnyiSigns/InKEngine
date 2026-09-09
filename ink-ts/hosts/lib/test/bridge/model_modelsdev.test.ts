/**
 * models.dev 能力映射测试：测的是「开源注册表 reasoning_options → reasoning_style
 * 映射 + 缓存 + 失败回退」——出网经注入桩，默认空/失败不崩。
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchModelsDevCatalog, clearModelsDevCache, lookupModelsDevCapability } from '../../src/bridge/model_modelsdev.js';
import type { CatalogFetch } from '../../src/bridge/model_catalog.js';

function json(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

describe('model_modelsdev 能力映射', () => {
  it('effort/toggle/budget/reasoning-only 映射为 effort/boolean/budget/none', async () => {
    clearModelsDevCache();
    const fetchImpl: CatalogFetch = vi.fn(async () => json({
      'anthropic': { models: { 'claude-opus-4-8': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] } } },
      'deepseek': { models: { 'deepseek-v3.2': { reasoning: true, reasoning_options: [{ type: 'toggle' }] } } },
      'openai': { models: { 'o3': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } } },
      'plain': { models: { 'plain-model': { reasoning: false } } },
    }));
    const map = await fetchModelsDevCatalog(fetchImpl);
    expect(map['claude-opus-4-8']).toEqual({ reasoning: true, reasoning_style: 'effort', reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(map['deepseek-v3.2']?.reasoning_style).toBe('boolean');
    expect(map['o3']?.reasoning_efforts).toEqual(['low', 'medium', 'high']);
    expect(map['plain-model']).toBeUndefined();
  });

  it('lookupModelsDevCapability：按完整 id 精确，再按模型尾段归一匹配', () => {
    const map: import('../../src/bridge/model_catalog.js').ModelCapabilityMap = { 'deepseek/deepseek-v4-flash': { reasoning: true, reasoning_style: 'boolean' } };
    expect(lookupModelsDevCapability(map, 'deepseek-v4-flash')?.reasoning_style).toBe('boolean');
    expect(lookupModelsDevCapability(map, 'deepseek/deepseek-v4-flash')?.reasoning_style).toBe('boolean');
    expect(lookupModelsDevCapability(map, 'other/model')).toBeUndefined();
  });

  it('失败/超时返回空，不抛；缓存命中后不再重复抓取', async () => {
    clearModelsDevCache();
    const bad: CatalogFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await fetchModelsDevCatalog(bad)).toEqual({});
    const good: CatalogFetch = vi.fn(async () => json({ 'x': { models: { 'm': { reasoning: true, reasoning_options: [{ type: 'toggle' }] } } } }));
    await fetchModelsDevCatalog(good);
    await fetchModelsDevCatalog(good);
    expect(good).toHaveBeenCalledTimes(1);
    clearModelsDevCache();
  });
});
