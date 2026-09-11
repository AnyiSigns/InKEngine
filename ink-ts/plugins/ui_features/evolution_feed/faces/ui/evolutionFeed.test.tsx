/**
 * 状态页测试：孵化/补丁时间线 + 协作者目录（只读展示/空态不白屏）。
 * 「当前回合图组成」段随 graph.instance 组装图投影退役删除（W7-B）。
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

const entitiesSnapshot = {
  version: 2,
  count: 2,
  entities: [
    { id: 'main_agent', label: '主 Agent', model: null },
    { id: 'security_reviewer', label: '安全评审', model: { provider: 'moonshotai-cn', model_id: 'kimi-k2' } },
  ],
};

describe('状态页·图组成段已退役（W7-B）', () => {
  it('有会话窗口也不再渲染「当前回合图组成」区块', async () => {
    render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackend(null)}
        threadId="thread-a"
      />,
    );
    await screen.findByText('还没有演化动态');
    expect(screen.queryByText('当前回合图组成')).not.toBeInTheDocument();
  });
});

describe('状态页·协作者目录', () => {
  it('entities.snapshot 有注册协作者 → 渲染目录（label/id/模型引用）', async () => {
    render(
      <EvolutionFeed
        incubation={[]}
        patchChain={[]}
        backend={mockBackendByCommand({
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
          entities_snapshot: { version: 0, count: 0, entities: [], degraded: true },
        })}
        threadId="thread-a"
      />,
    );
    await screen.findByText('还没有演化动态');
    expect(screen.queryByText('协作者目录')).not.toBeInTheDocument();
  });
});
