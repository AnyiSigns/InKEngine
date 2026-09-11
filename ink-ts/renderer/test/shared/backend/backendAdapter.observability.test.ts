/**
 * 后端适配器可观测/演化读面测试：serve 通道命令名对齐 + 无通道回落 +
 * mock 后端契约（modelArchiveSnapshot/metricsSnapshot/只读投影方法）。
 * 组装链读面（assemble.stats/cache.stats/graph.instance/pool.*）已随组装
 * 链路退役（W7-B）。
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
  it('指标/模型/边证据/实体命令名对齐点分只读方法', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.modelArchiveSnapshot();
    await backend.metricsSnapshot();
    await backend.entitiesSnapshot();
    await backend.edgeEvidenceList();
    await backend.knowledgeGraph();
    expect(calls.map((c) => c.cmd)).toEqual([
      'model_archive.snapshot',
      'metrics.snapshot',
      'entities.snapshot',
      'edge_evidence.list',
      'knowledge.graph',
    ]);
    expect(calls[4].args).toEqual({});
  });
});

describe('无宿主回落', () => {
  it('不可用适配器：可观测/演化只读方法调用抛错（不静默）', () => {
    const backend = createUnavailableBackend();
    expect(backend.available).toBe(false);
    expect(() => backend.metricsSnapshot()).toThrow(/宿主后端不可用/);
    expect(() => backend.edgeEvidenceList()).toThrow(/宿主后端不可用/);
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
      entitiesSnapshot: vi.fn(async () => ({ degraded: true, entities: [] })),
      edgeEvidenceList: vi.fn(async () => ({ available: true, edges: [] })),
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

  it('edgeEvidenceList 回传边证据窗口（mock 只读投影）', async () => {
    const backend = mockBackend();
    const stats = await backend.edgeEvidenceList();
    expect(stats).toBeTruthy();
    expect((stats as { edges: unknown[] }).edges).toEqual([]);
  });

  it('modelArchiveSnapshot 回传档案列表', async () => {
    const backend = mockBackend();
    const snap = await backend.modelArchiveSnapshot();
    expect(snap.archives).toEqual([]);
    expect(backend.modelArchiveSnapshot).toHaveBeenCalledTimes(1);
  });
});