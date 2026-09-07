/**
 * 后端适配器可观测/演化读面测试：serve 通道命令名对齐 + 无通道回落 +
 * mock 后端契约（modelArchiveSnapshot/metricsSnapshot/只读投影方法）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createServeBackend,
  createUnavailableBackend,
  type BackendAdapter,
  type MetricsSnapshotView,
  type ModelArchiveSnapshot,
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
    upload: async () => null,
  };
  return { channel, calls };
}

describe('serve 通道：可观测/演化只读命令对齐', () => {
  it('指标/模型/统计/池/边证据/实体命令名对齐点分只读方法', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.modelArchiveSnapshot();
    await backend.metricsSnapshot();
    await backend.assembleStats();
    await backend.cacheStats();
    await backend.graphInstanceSnapshot('thread-a');
    await backend.poolSnapshot();
    await backend.entitiesSnapshot();
    await backend.edgeEvidenceList();
    await backend.knowledgeGraph();
    expect(calls.map((c) => c.cmd)).toEqual([
      'model_archive.snapshot',
      'metrics.snapshot',
      'assemble.stats',
      'cache.stats',
      'graph.instance',
      'pool.snapshot',
      'entities.snapshot',
      'edge_evidence.list',
      'knowledge.graph',
    ]);
    expect(calls[4].args).toEqual({ thread_id: 'thread-a' });
    expect(calls[8].args).toEqual({});
  });

  it('pool.evaluate 直调点分方法并透传 proposal', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.poolEvaluate({ node_id: 'n1', fields: ['f1'] });
    expect(calls[0].cmd).toBe('pool.evaluate');
    expect(calls[0].args).toEqual({ proposal: { node_id: 'n1', fields: ['f1'] } });
  });
});

describe('无宿主回落', () => {
  it('不可用适配器：可观测/演化只读方法调用抛错（不静默）', () => {
    const backend = createUnavailableBackend();
    expect(backend.available).toBe(false);
    expect(() => backend.metricsSnapshot()).toThrow(/宿主后端不可用/);
    expect(() => backend.poolSnapshot()).toThrow(/宿主后端不可用/);
    expect(() => backend.modelArchiveSnapshot()).toThrow(/宿主后端不可用/);
  });
});

describe('mock 后端契约', () => {
  function mockBackend(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
    return {
      available: true,
      modelArchiveSnapshot: vi.fn(async (): Promise<ModelArchiveSnapshot> => ({ archives: [] })),
      metricsSnapshot: vi.fn(async (): Promise<MetricsSnapshotView> => ({
        available: true,
        rounds: 1,
        failures: 0,
        avg: 0,
        last_error: null,
        llm_calls_by_role: { agent: 3 },
      })),
      assembleStats: vi.fn(async () => ({ available: true, stats: {}, cache_entries: 4 })),
      graphInstanceSnapshot: vi.fn(async () => ({ degraded: true, graph: { nodes: [], edges: [] }, node_status: {} })),
      poolSnapshot: vi.fn(async () => ({ available: true, counts: {}, rows: [] })),
      poolEvaluate: vi.fn(async () => ({ available: true, evaluated: true })),
      entitiesSnapshot: vi.fn(async () => ({ degraded: true, entities: [] })),
      edgeEvidenceList: vi.fn(async () => ({ available: true, edges: [] })),
      cacheStats: vi.fn(async () => ({ available: true, entries: 0 })),
      knowledgeGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
      ...overrides,
    } as BackendAdapter;
  }

  it('metricsSnapshot 回传聚合形态（缺装配 = available:false 空态）', async () => {
    const backend = mockBackend();
    const snap = await backend.metricsSnapshot();
    expect(snap.available).toBe(true);
    expect(snap.rounds).toBe(1);
    expect(backend.metricsSnapshot).toHaveBeenCalledTimes(1);
  });

  it('assembleStats 回传统计（mock 只读投影）', async () => {
    const backend = mockBackend();
    const stats = await backend.assembleStats();
    expect(stats).toBeTruthy();
    expect((stats as { cache_entries: number }).cache_entries).toBe(4);
  });

  it('modelArchiveSnapshot 回传档案列表', async () => {
    const backend = mockBackend();
    const snap = await backend.modelArchiveSnapshot();
    expect(snap.archives).toEqual([]);
    expect(backend.modelArchiveSnapshot).toHaveBeenCalledTimes(1);
  });
});
