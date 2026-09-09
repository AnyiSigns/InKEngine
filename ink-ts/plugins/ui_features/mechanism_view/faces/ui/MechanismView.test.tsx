/**
 * MechanismView 测试：状态页机制读取面分层卡。
 * 测的是：后端可用时渲染 ① 回合概览 + ② 结点池卡（registry 活跃/总数 +
 * 治理 + 边证据 + 实体四组）+ ④ 机制装配（组装链/指纹缓存）层级；
 * 宿主不可用 = 空态不白屏。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { createServeBackend } from '@/shared/backend/backendAdapter';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ServeChannel } from '@/shared/backend/transport';

import { MechanismView } from './MechanismView';

function mockChannel(routes: Record<string, unknown>): ServeChannel {
  return {
    available: true,
    request: (async (cmd: string) => (cmd in routes ? routes[cmd] : undefined)) as ServeChannel['request'],
    subscribe: async () => () => undefined,
    upload: async () => null,
  };
}

function mockBackend(routes: Record<string, unknown>): BackendAdapter {
  return createServeBackend(mockChannel(routes));
}

const reads: Record<string, unknown> = {
  'metrics.snapshot': { available: true, rounds: 5, failures: 1, avg: 0.2, crystallized: 0 },
  'assemble.stats': {
    available: true,
    assembler_enabled: true,
    contract_enabled: true,
    canary_gate: false,
    stats: { assembled: 3 },
  },
  'cache.stats': {
    fingerprint_cache: { available: true, entries: 4, stats: { lookups: 10, upserts: 2 } },
  },
  'path.state': {
    available: true,
    enabled: { assembler: true, contract: true },
    canary_gate: false,
    candidates: { last_assembly_count: 2, chosen_candidate: null },
  },
  'pool.snapshot': {
    available: true,
    counts: { pool_count: 3, evaluations: 4, dead_node_candidates: 1 },
    last_round: null,
    registry: {
      available: true,
      total_count: 2,
      active_count: 2,
      types: [
        { type_name: 'llm_decider', status: 'active', provenance: 'seed', executor: 'engine:llm_decider' },
        { type_name: 'tool_pipeline', status: 'active', provenance: 'seed', executor: 'engine:tool_pipeline' },
      ],
    },
    degraded: false,
  },
  'edge_evidence.list': { available: true, edges: [{ policy: true }, { policy: false }] },
  'entities.snapshot': { available: true, count: 1, max: 200, entities: [], degraded: false },
};

describe('MechanismView 分层读取面', () => {
  it('后端可用 → 回合概览 + 结点池卡（结点注册/治理/边证据/实体）+ 机制装配小卡组', async () => {
    const { container } = render(<MechanismView backend={mockBackend(reads)} threadId="thread-a" />);
    expect(await screen.findByText('回合概览')).toBeInTheDocument();
    expect(screen.getByText('机制装配')).toBeInTheDocument();
    expect(screen.getByText('组装链')).toBeInTheDocument();
    expect(screen.getByText('指纹缓存')).toBeInTheDocument();

    const poolCard = container.querySelector('[data-card="结点池"]');
    expect(poolCard).not.toBeNull();
    expect(poolCard?.textContent).toContain('结点注册');
    expect(poolCard?.textContent).toContain('注册总数');
    expect(poolCard?.textContent).toContain('2');
    expect(poolCard?.textContent).toContain('治理');
    expect(poolCard?.textContent).toContain('登记');
    expect(poolCard?.textContent).toContain('死结点候选');
    expect(poolCard?.textContent).toContain('边证据');
    expect(poolCard?.textContent).toContain('边数');
    expect(poolCard?.textContent).toContain('策略边');
    expect(poolCard?.textContent).toContain('实体');
    expect(poolCard?.textContent).toContain('配额');
  });

  it('结点池 registry 无数据源 → 该组空态文案（不白屏）', async () => {
    const { container } = render(
      <MechanismView
        backend={mockBackend({ ...reads, 'pool.snapshot': { ...reads['pool.snapshot'], registry: { available: false, total_count: 0, active_count: 0, types: [] } } })}
        threadId="thread-a"
      />,
    );
    const poolCard = await screen.findByText('结点池');
    expect(poolCard).toBeInTheDocument();
    const card = container.querySelector('[data-card="结点池"]');
    expect(card?.textContent).toContain('registry 未装配');
  });

  it('宿主不可用 → 整页空态（不白屏）', () => {
    render(<MechanismView backend={null} threadId="" />);
    expect(screen.getByText('状态读取面仅在宿主运行时可用')).toBeInTheDocument();
  });

  it('metrics.snapshot 未带独立 auto 计数 → 「自动续跑轮」行以「—」展示并注明待 metrics 字段', async () => {
    const { container } = render(
      <MechanismView
        backend={mockBackend({ ...reads, 'metrics.snapshot': { available: true, rounds: 5, failures: 1, avg: 0.2 } })}
        threadId="thread-a"
      />,
    );
    await screen.findByText('回合概览');
    const card = container.querySelector('[data-card="回合概览"]');
    expect(card?.textContent).toContain('自动续跑轮');
    expect(card?.textContent).toContain('自动续跑轮—');
    expect(card?.textContent).toContain('待 metrics 快照字段');
  });

  it('metrics.snapshot 已带独立 auto 计数（auto_rounds）→ 「自动续跑轮」行展示计数', async () => {
    const { container } = render(
      <MechanismView
        backend={mockBackend({ ...reads, 'metrics.snapshot': { available: true, rounds: 5, auto_rounds: 2, failures: 1, avg: 0.2 } })}
        threadId="thread-a"
      />,
    );
    await screen.findByText('回合概览');
    const card = container.querySelector('[data-card="回合概览"]');
    expect(card?.textContent).toContain('自动续跑轮2');
  });
});
