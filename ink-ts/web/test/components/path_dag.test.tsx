/**
 * 组装路径 DAG 测试：喂 assembly_candidate + junction_verdict 事件 →
 * 路径节点 / 汇流点渲染（经通道中枢订阅实时更新）。
 */

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PathDag } from '@/components/path_dag';
import { ChannelHub } from '@/shared/session/channelHub';
import type { HubEvent } from '@/shared/session/channelHub';

function ev(type: string, payload: Record<string, unknown> = {}, at = 1): HubEvent {
  return { type: type as HubEvent['type'], payload, at };
}

describe('组装路径 DAG', () => {
  it('assembly_candidate 绘制节点与边', async () => {
    const hub = new ChannelHub();
    render(<PathDag hub={hub} />);
    hub.dispatch(
      ev('assembly_candidate', {
        candidates: [{ chain: ['intent', 'answer', 'verify'] }],
      }),
    );
    await waitFor(() => expect(screen.getByText('intent')).toBeInTheDocument());
    expect(screen.getByText('answer')).toBeInTheDocument();
    expect(screen.getByText('verify')).toBeInTheDocument();
    expect(screen.getByText('intent → answer')).toBeInTheDocument();
    expect(screen.getByText('answer → verify')).toBeInTheDocument();
  });

  it('junction_verdict 高亮汇流点', async () => {
    const hub = new ChannelHub();
    render(<PathDag hub={hub} />);
    hub.dispatch(ev('assembly_candidate', { candidates: [{ chain: ['a', 'b', 'c'] }] }));
    hub.dispatch(ev('junction_verdict', { winner: 'b' }));
    await waitFor(() => {
      const junction = screen.getByText('b');
      expect(junction.getAttribute('data-junction')).toBe('true');
    });
    const a = screen.getByText('a');
    expect(a.getAttribute('data-junction')).toBe('false');
  });

  it('plan_start 建根节点', async () => {
    const hub = new ChannelHub();
    render(<PathDag hub={hub} />);
    hub.dispatch(ev('plan_start', { workflow: 'research' }));
    await waitFor(() => expect(screen.getByText('research')).toBeInTheDocument());
  });

  it('空态不崩', () => {
    const hub = new ChannelHub();
    render(<PathDag hub={hub} />);
    expect(screen.getByText(/暂无路径/)).toBeInTheDocument();
  });
});
