/**
 * 演化页测试：孵化/补丁时间线 + 最近回合实例图（按会话窗口查询）。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EvolutionFeed } from '@/app/session/EvolutionFeed';
import { createTauriBackend } from '@/shared/backend/backendAdapter';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { TauriInvoker } from '@/shared/backend/tauriBridge';

function mockBackend(snap: unknown): BackendAdapter {
  const invoker: TauriInvoker = {
    invoke: async () => snap,
  };
  return createTauriBackend(invoker);
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

describe('演化页·最近回合实例图', () => {
  it('按当前会话 thread_id 查询并渲染执行态', async () => {
    render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackend(instanceSnapshot)}
        threadId="thread-a"
      />,
    );
    expect(await screen.findByText('最近回合执行图')).toBeInTheDocument();
    expect(screen.getByText(/回合 r-1/)).toBeInTheDocument();
    expect(await screen.findByTestId('dag-node-n1')).toHaveAttribute('data-status', 'success');
    expect(screen.getByTestId('dag-node-n2')).toHaveAttribute('data-status', 'failed');
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
    expect(screen.queryByText('最近回合执行图')).not.toBeInTheDocument();
    expect(await screen.findByText('演化动态')).toBeInTheDocument();
  });

  it('引擎返回空态 → 不渲染实例区块（不白屏）', async () => {
    render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackend(null)}
        threadId="thread-a"
      />,
    );
    expect(screen.queryByText('最近回合执行图')).not.toBeInTheDocument();
  });
});
