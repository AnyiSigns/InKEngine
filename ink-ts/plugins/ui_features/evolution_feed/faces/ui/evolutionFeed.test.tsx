/**
 * 状态页测试：孵化/补丁时间线 + 当前回合图组成清单（按会话窗口查询）
 * + 协作者目录。测的是：图组成渲染结点行+运行态徽标与走过的边、无 DAG；
 * 时间线与协作者目录只读展示/空态不白屏。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EvolutionFeed } from './EvolutionFeed';
import { createServeBackend } from '@/shared/backend/backendAdapter';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ServeChannel } from '@/shared/backend/transport';

function mockChannel(respond: (cmd: string) => unknown): ServeChannel {
  return {
    available: true,
    request: (async (cmd: string) => respond(String(cmd))) as ServeChannel['request'],
    subscribe: async () => () => undefined,
    upload: async () => null,
  };
}

function mockBackend(snap: unknown): BackendAdapter {
  return createServeBackend(mockChannel(() => snap));
}

function mockBackendByCommand(routes: Record<string, unknown>): BackendAdapter {
  return createServeBackend(
    mockChannel((cmd) => (cmd in routes ? routes[cmd] : undefined)),
  );
}

const instanceSnapshot = {
  round_id: 'r-1',
  graph: {
    nodes: [
      { id: 'n1', type: 'orchestrator', label: '编排' },
      { id: 'n2', type: 'tool', label: '工具' },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  },
  node_status: { n1: 'success', n2: 'failed' },
};

const entitiesSnapshot = {
  version: 2,
  count: 2,
  entities: [
    { id: 'main_agent', label: '主 Agent', model: null },
    { id: 'security_reviewer', label: '安全评审', model: { provider: 'moonshotai-cn', model_id: 'kimi-k2' } },
  ],
};

describe('状态页·当前回合图组成', () => {
  it('按当前会话 thread_id 查询并渲染组成清单：结点行 + 运行态徽标 + 走过的边 + 未召唤 agent 占位（无 DAG）', async () => {
    const { container } = render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackend(instanceSnapshot)}
        threadId="thread-a"
      />,
    );
    expect(await screen.findByText('当前回合图组成')).toBeInTheDocument();
    expect(screen.getByText(/回合 r-1/)).toBeInTheDocument();
    const successRow = container.querySelector('[data-node-row][data-status="success"]');
    expect(successRow?.textContent).toContain('编排');
    const failedRow = container.querySelector('[data-node-row][data-status="failed"]');
    expect(failedRow?.textContent).toContain('工具');
    expect(container.querySelector('[data-node-row][data-status="success"] [data-status-badge="success"]')?.textContent).toBe('成功');
    expect(container.querySelector('[data-node-row][data-status="failed"] [data-status-badge="failed"]')?.textContent).toBe('失败');
    expect(container.querySelector('[data-edge-row]')?.textContent).toContain('编排 → 工具');
    expect(screen.getByText('本回合未召唤协作者')).toBeInTheDocument();
    expect(container.querySelector('[data-testid^="dag-node-"]')).toBeNull();
  });

  it('无会话窗口（空 thread_id）不拉取，展示演化时间线', async () => {
    render(
      <EvolutionFeed
        incubation={[
          { id: 'sig-1', signal: '信号', signalType: 'insight', stage: 'passed', createdAt: 1, verdict: '放行' },
        ]}
        patchChain={[]}
        backend={mockBackend(instanceSnapshot)}
        threadId=""
      />,
    );
    expect(screen.queryByText('当前回合图组成')).not.toBeInTheDocument();
    expect(await screen.findByText('演化动态')).toBeInTheDocument();
  });

  it('引擎返回空态 → 不渲染图组成区块（不白屏）', async () => {
    render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackend(null)}
        threadId="thread-a"
      />,
    );
    expect(screen.queryByText('当前回合图组成')).not.toBeInTheDocument();
  });

  it('最近一回合为自动续跑轮（round_id auto:*）→ 图组成头部渲染「自动续跑」徽标与触发原因', async () => {
    const { container } = render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackend({
          round_id: 'auto:k-abc',
          auto_round: true,
          continuation_reason: 'evolved',
          graph: {
            nodes: [{ id: 'n1', type: 'orchestrator', label: '编排' }],
            edges: [],
          },
          node_status: { n1: 'success' },
        })}
        threadId="thread-auto"
      />,
    );
    expect(await screen.findByText('当前回合图组成')).toBeInTheDocument();
    expect(screen.getByText(/回合 auto:k-abc/)).toBeInTheDocument();
    const badge = container.querySelector('[data-auto-round]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('自动续跑');
    expect(badge?.textContent).toContain('进化后续跑');
  });

  it('最近一回合为普通轮（非 auto）→ 无自动续跑徽标', async () => {
    const { container } = render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackend({ ...instanceSnapshot, auto_round: false, continuation_reason: null })}
        threadId="thread-plain"
      />,
    );
    expect(await screen.findByText('当前回合图组成')).toBeInTheDocument();
    expect(container.querySelector('[data-auto-round]')).toBeNull();
  });
});

describe('状态页·协作者目录', () => {
  it('entities.snapshot 有注册协作者 → 渲染目录（label/id/模型引用）', async () => {
    render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackendByCommand({
          'graph.instance': null,
          'entities.snapshot': entitiesSnapshot,
        })}
        threadId="thread-a"
      />,
    );
    expect(await screen.findByText('协作者目录')).toBeInTheDocument();
    expect(screen.getByText(/安全评审/)).toBeInTheDocument();
    expect(screen.getByText('security_reviewer')).toBeInTheDocument();
    expect(screen.getByText(/moonshotai-cn\/kimi-k2/)).toBeInTheDocument();
  });

  it('entities.snapshot 空注册表 → 不渲染目录（空态不白屏）', async () => {
    render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackendByCommand({
          graph_instance_snapshot: null,
          entities_snapshot: { version: 0, count: 0, entities: [] },
        })}
        threadId="thread-a"
      />,
    );
    await screen.findByText('还没有演化动态');
    expect(screen.queryByText('协作者目录')).not.toBeInTheDocument();
  });

  it('entities.snapshot 出错 → 不渲染目录（不白屏）', async () => {
    render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackendByCommand({
          graph_instance_snapshot: null,
          entities_snapshot: { version: 0, count: 0, entities: [], degraded: true },
        })}
        threadId="thread-a"
      />,
    );
    await screen.findByText('还没有演化动态');
    expect(screen.queryByText('协作者目录')).not.toBeInTheDocument();
  });
});
