/**
 * MechanismView 测试：状态页机制读取面分层卡。
 * 测的是：后端可用时渲染 ① 回合概览（自动续跑轮独立计数，缺省「—」+ 主线口径
 * caption）② 边证据 ③ 实体三卡；读取失败/无装配 = 结构化空态文案不白屏；
 * 宿主不可用 = 整页空态。组装链读数（pool.snapshot / assemble.stats /
 * path.state / cache.stats）与「结点池/机制装配」卡组已随组装链路退役（W7-B）。
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
  'edge_evidence.list': { available: true, edges: [{ policy: true }, { policy: false }] },
  'entities.snapshot': { available: true, count: 1, max: 200, entities: [], degraded: false },
};

describe('MechanismView 分层读取面', () => {
  it('后端可用 → 回合概览 + 边证据 + 实体三卡（结点池/机制装配卡组已退役）', async () => {
    const { container } = render(<MechanismView backend={mockBackend(reads)} threadId="thread-a" />);
    expect(await screen.findByText('回合概览')).toBeInTheDocument();
    const edgeCard = container.querySelector('[data-card="边证据"]');
    expect(edgeCard?.textContent).toContain('边数');
    expect(edgeCard?.textContent).toContain('策略边');
    const entCard = container.querySelector('[data-card="实体"]');
    expect(entCard?.textContent).toContain('配额');
    expect(screen.queryByText('机制装配')).not.toBeInTheDocument();
    expect(container.querySelector('[data-card="结点池"]')).toBeNull();
  });

  it('读面无数据源 → 结构化空态文案（不白屏）', async () => {
    const { container } = render(<MechanismView backend={mockBackend({})} threadId="thread-a" />);
    await screen.findByText('回合概览');
    const card = container.querySelector('[data-card="边证据"]');
    expect(card?.textContent).toContain('edge_evidence.list 无装配');
    expect(container.querySelector('[data-card="实体"]')?.textContent).toContain('无装配');
  });

  it('宿主不可用 → 整页空态（不白屏）', () => {
    render(<MechanismView backend={null} threadId="" />);
    expect(screen.getByText('状态读取面仅在宿主运行时可用')).toBeInTheDocument();
  });

  it('metrics.snapshot 未带独立 auto 计数 → 「自动续跑轮」行以「—」展示并带主线口径 caption', async () => {
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
    expect(card?.textContent).toContain('主线执行不经该通道');
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
