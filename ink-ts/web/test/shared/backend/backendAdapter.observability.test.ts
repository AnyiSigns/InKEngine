/**
 * 后端适配器可观测/干预方法测试：serve 通道命令名对齐 + 无通道回落 +
 * mock 后端契约（modelArchiveSnapshot/metricsSnapshot/assembleStats/四 op）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createServeBackend,
  createUnavailableBackend,
  type BackendAdapter,
  type AssembleStats,
  type ModelArchiveSnapshot,
  type TurnMetricsSnapshot,
} from '@/shared/backend/backendAdapter';
import type { ServeChannel } from '@/shared/backend/transport';

function mockChannel(): { channel: ServeChannel; calls: Array<{ cmd: string; args: unknown }> } {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  const channel: ServeChannel = {
    available: true,
    request: (async (cmd: string, params?: unknown) => {
      calls.push({ cmd, args: params ?? {} });
      return {};
    }) as ServeChannel['request'],
    subscribe: async () => () => undefined,
  };
  return { channel, calls };
}

describe('serve 通道：可观测/干预命令对齐', () => {
  it('指标/模型/统计 + 四 op 命令名对齐通道；无宿主命令显式降级', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.modelArchiveSnapshot();
    await backend.metricsSnapshot();
    await backend.assembleStats();
    await backend.chooseCandidate('c1');
    await backend.setMultipath(true);
    await backend.invalidateCache('default');
    await backend.downgradeEdgeTier('e1');
    await backend.rebuildCache('default');
    await backend.restoreEdgeTier('e1');
    await backend.knowledgeGraph();
    expect(calls.map((c) => c.cmd)).toEqual([
      'model_archive_snapshot',
      'metrics_snapshot',
      'assemble_stats',
      'path_choose_candidate',
      'path_set_multipath',
      'cache_invalidate',
      'edge_downgrade_tier',
      'cache_rebuild',
      'edge_restore_tier',
      'knowledge.graph',
    ]);
    expect(calls[0].args).toEqual({});
    expect(calls[3].args).toEqual({ candidateId: 'c1' });
    expect(calls[4].args).toEqual({ enabled: true });
    expect(calls[7].args).toEqual({ domain: 'default' });
    expect(calls[8].args).toEqual({ edgeId: 'e1' });
    expect(calls[9].args).toEqual({});
  });
});

describe('无宿主回落', () => {
  it('不可用适配器：可观测/干预方法调用抛错（不静默）', () => {
    const backend = createUnavailableBackend();
    expect(backend.available).toBe(false);
    expect(() => backend.metricsSnapshot()).toThrow(/宿主后端不可用/);
    expect(() => backend.chooseCandidate('c1')).toThrow(/宿主后端不可用/);
    expect(() => backend.modelArchiveSnapshot()).toThrow(/宿主后端不可用/);
  });
});

describe('mock 后端契约', () => {
  function mockBackend(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
    return {
      available: true,
      modelArchiveSnapshot: vi.fn(async (): Promise<ModelArchiveSnapshot> => ({ archives: [] })),
      metricsSnapshot: vi.fn(async (): Promise<TurnMetricsSnapshot> => ({
        ok: true,
        turn_metrics: { turns: 1, failures: 0 },
        llm: { prompt_tokens_total: 30, completion_tokens_total: 15, tokens_total: 45, last_prompt_tokens: 30, last_completion_tokens: 15, calls_total: 3 },
        cache: { hits: 9, misses: 1, invalidations: 0, replacements: 0, hit_rate: 0.9, caching_llm: {} },
        edges: { count: 1, avg_cost_mean: 0.1, avg_cost_min: 0.1, avg_cost_max: 0.1 },
        cache_entries: 4,
        occupancy: null,
      })),
      assembleStats: vi.fn(async (): Promise<AssembleStats> => ({
        ok: true,
        stats: { cache_hits: 9, cache_misses: 1, cache_invalidations: 0, cache_replacements: 0 },
        cache_entries: 4,
      })),
      chooseCandidate: vi.fn(async () => ({ chosen: 'c1' })),
      setMultipath: vi.fn(async () => ({ multipath: true })),
      invalidateCache: vi.fn(async () => ({ cleared: 'default' })),
      downgradeEdgeTier: vi.fn(async () => ({ edge: 'e1', tier: 'low' })),
      ...overrides,
    } as BackendAdapter;
  }

  it('chooseCandidate 回传选中', async () => {
    const backend = mockBackend();
    expect(await backend.chooseCandidate('c1')).toEqual({ chosen: 'c1' });
    expect(backend.chooseCandidate).toHaveBeenCalledWith('c1');
  });

  it('assembleStats 仅消费聚合统计（不引用缓存存储内部 API）', async () => {
    const backend = mockBackend();
    const stats = await backend.assembleStats();
    expect(stats.stats.cache_hits).toBe(9);
    expect(stats.cache_entries).toBe(4);
    expect(stats.ok).toBe(true);
  });

  it('modelArchiveSnapshot 回传档案列表', async () => {
    const backend = mockBackend();
    const snap = await backend.modelArchiveSnapshot();
    expect(snap.archives).toEqual([]);
    expect(backend.modelArchiveSnapshot).toHaveBeenCalledTimes(1);
  });
});
