/**
 * model_archive 命令面测试：测的是「档案快照聚合 + 推理能力字段透传」——
 * 厂商模型条目若声明 reasoning/reasoning_efforts，应原样进入档案行；
 * 非法档位被剔除；未声明 = 字段缺失（前端回退显示默认 auto）。
 */

import { describe, it, expect } from 'vitest';
import { collectArchiveRows } from '../../src/bridge/model_archive.js';
import { buildModelArchiveCommands } from '../../src/bridge/model_archive.js';
import type { HostBridgeDeps } from '../../src/bridge/_types.js';
import type { CatalogFetch } from '../../src/bridge/model_catalog.js';

function makeCatalogFetch(byModel: Record<string, unknown>): CatalogFetch {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: Object.entries(byModel).map(([id, rest]) => ({ id, ...(rest as object) })),
    }),
  });
}

const DEPS_BASE = {
  autoApprove: false,
  catalogFetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  host: {
    model_config_state: () => ({
      model_config: {
        agent_config: { protocol: 'openai_compatible', base_url: 'https://gw.test/api', model_id: 'a/vendor-effort' },
        agent_fallback_configs: [{ protocol: 'openai_compatible', base_url: 'https://gw.test/api', model_id: 'b/no-meta' }],
      } as Record<string, unknown>,
    }),
  } as unknown as HostBridgeDeps['host'],
} as unknown as HostBridgeDeps;

describe('collectArchiveRows（推理能力透传）', () => {
  it('厂商模型条目声明 reasoning/reasoning_efforts 时透传入档案行', () => {
    const rows = collectArchiveRows({
      providers: [
        {
          provider_id: 'p',
          base_url: 'https://example.com',
          models: [
            { model_id: 'm-effort', reasoning: true, reasoning_style: 'effort', reasoning_efforts: ['low', 'high'] },
            { model_id: 'm-none', reasoning_style: 'none' },
            { model_id: 'm-plain' },
          ],
        },
      ],
    });
    const effort = rows.find((r) => r.model_id === 'm-effort');
    expect(effort?.reasoning).toBe(true);
    expect(effort?.reasoning_style).toBe('effort');
    expect(effort?.reasoning_efforts).toEqual(['low', 'high']);
    expect(rows.find((r) => r.model_id === 'm-none')?.reasoning_style).toBe('none');
    expect(rows.find((r) => r.model_id === 'm-none')?.reasoning).toBe(false);
    expect(rows.find((r) => r.model_id === 'm-plain')?.reasoning).toBeUndefined();
  });

  it('reasoning_style 可从端点配置的 extra 读取（LLMConfig 形态）', () => {
    const rows = collectArchiveRows({
      agent_config: {
        adapter: 'openai_compatible',
        base_url: 'https://example.com',
        model_id: 'm1',
        extra: { reasoning_style: 'boolean' },
      },
    });
    expect(rows[0]?.reasoning_style).toBe('boolean');
    expect(rows[0]?.reasoning).toBe(true);
  });

  it('模型条目未声明推理能力、厂商未发布、目录未命中 → 保持未知（不硬编码）', async () => {
    const deps = {
      ...DEPS_BASE,
      host: {
        model_config_state: () => ({
          model_config: {
            agent_config: { adapter: 'openai_compatible', base_url: 'https://example.com', model_id: 'deepseek-v4-flash' },
            agent_fallback_configs: [{ adapter: 'openai_compatible', base_url: 'https://example.com', model_id: 'some-unknown-model' }],
          } as Record<string, unknown>,
        }),
      } as unknown as HostBridgeDeps['host'],
    } as HostBridgeDeps;
    const cmd = buildModelArchiveCommands(deps);
    const out = (await cmd['model_archive.snapshot']({}, {} as never)) as { archives: Array<Record<string, unknown>> };
    expect(out.archives.find((r) => r['model_id'] === 'deepseek-v4-flash')?.['reasoning']).toBeUndefined();
    expect(out.archives.find((r) => r['model_id'] === 'some-unknown-model')?.['reasoning']).toBeUndefined();
  });

  it('非法/非布尔 reasoning 与非法档位一律忽略（未声明语义）', () => {
    const rows = collectArchiveRows({
      providers: [
        {
          provider_id: 'p',
          base_url: 'https://example.com',
          models: [
            { model_id: 'm1', reasoning: 'yes', reasoning_efforts: ['high', 'ultra'] },
          ],
        },
      ],
    });
    expect(rows[0]?.reasoning).toBeUndefined();
    expect(rows[0]?.reasoning_efforts).toEqual(['high', 'ultra']);
  });

  it('官配档案字段不影响既有聚合（字典序/去重）', () => {
    const rows = collectArchiveRows({
      providers: [
        {
          provider_id: 'p',
          base_url: 'https://example.com',
          models: [{ model_id: 'b' }, { model_id: 'a' }],
        },
      ],
    });
    expect(rows.map((r) => r.model_id)).toEqual(['a', 'b']);
  });

  it('snapshot 结合厂商元数据抓取：厂商给出能力则用，未给出保持未知', async () => {
    const deps = {
      ...DEPS_BASE,
      catalogFetch: makeCatalogFetch({ 'a/vendor-effort': { supported_parameters: ['reasoning_effort'] } }),
    } as HostBridgeDeps;
    const cmd = buildModelArchiveCommands(deps);
    const out = (await cmd['model_archive.snapshot']({}, {} as never)) as { archives: Array<Record<string, unknown>> };
    const vendor = out.archives.find((r) => r['model_id'] === 'a/vendor-effort');
    expect(vendor?.['reasoning_style']).toBe('effort');
    expect(vendor?.['reasoning']).toBe(true);
    const noMeta = out.archives.find((r) => r['model_id'] === 'b/no-meta');
    expect(noMeta?.['reasoning']).toBeUndefined();
  });
});
