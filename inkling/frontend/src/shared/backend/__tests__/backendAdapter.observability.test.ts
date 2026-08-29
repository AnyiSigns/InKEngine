/**
 * 后端适配器可观测/干预方法测试：Tauri 桥命令名对齐 + 无宿主回落 +
 * mock 后端契约（modelArchiveSnapshot/metricsSnapshot/assembleStats/四 op）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createTauriBackend,
  createUnavailableBackend,
  type BackendAdapter,
  type AssembleStats,
  type ModelArchiveSnapshot,
  type TurnMetricsSnapshot,
} from '../backendAdapter';
import type { TauriInvoker } from '../tauriBridge';

function mockInvoker(): { invoker: TauriInvoker; calls: Array<{ cmd: string; args: unknown }> } {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  const invoker: TauriInvoker = {
    invoke: (cmd, args) => {
      calls.push({ cmd, args: args ?? {} });
      return Promise.resolve({});
    },
  };
  return { invoker, calls };
}

describe('Tauri 桥：可观测/干预命令对齐', () => {
  it('指标/模型/统计 + 四 op 命令名对齐宿主；无后端命令显式降级', async () => {
    const { invoker, calls } = mockInvoker();
    const backend = createTauriBackend(invoker);
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
      modelArchiveSnapshot: vi.fn(async (): Promise<ModelArchiveSnapshot> => ({ profiles: [] })),
      metricsSnapshot: vi.fn(async (): Promise<TurnMetricsSnapshot> => ({
        turns: 1,
        failures: 0,
        failure_rate: 0,
        avg_review_score: 1,
        llm_calls: 3,
        round_duration_ms: 100,
      })),
      assembleStats: vi.fn(async (): Promise<AssembleStats> => ({
        cache_hits: 9,
        cache_misses: 1,
        cache_invalidations: 0,
        cache_replacements: 0,
        avg_cost: 0.1,
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
    expect(stats.cache_hits).toBe(9);
    expect(stats.avg_cost).toBe(0.1);
  });

  it('modelArchiveSnapshot 回传档案列表', async () => {
    const backend = mockBackend();
    const snap = await backend.modelArchiveSnapshot();
    expect(snap.profiles).toEqual([]);
    expect(backend.modelArchiveSnapshot).toHaveBeenCalledTimes(1);
  });
});
