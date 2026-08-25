/**
 * 任务面板测试：喂事件序列（plan_start→spawn_start×N→tool_end×N→end）
 * 经 ingest 归约到 task_state，面板呈现 N 行子任务终态 + 步进计数正确。
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TaskPanel } from '@/components/task_panel';
import { ChannelHub } from '@/shared/session/channelHub';
import { ingestEvent } from '@/shared/session/eventIngest';
import type { HubEvent } from '@/shared/session/channelHub';

function ev(type: HubEvent['type'], payload: Record<string, unknown> = {}, at = 1): HubEvent {
  return { type, payload, at };
}

function feed(hub: ChannelHub, events: HubEvent[]): void {
  for (const e of events) ingestEvent(hub, e);
}

describe('任务面板：子任务终态 + 步进计数', () => {
  it('plan_start→spawn_start×3→tool_end×3→end 呈现 3 行完成 + 步进 3/3', () => {
    const hub = new ChannelHub();
    const events: HubEvent[] = [ev('plan_start', { steps: 3, plan_id: 'p' })];
    for (let i = 0; i < 3; i += 1) {
      events.push(ev('spawn_start', { node_id: `n${i}`, label: `子任务${i}` }));
    }
    for (let i = 0; i < 3; i += 1) {
      events.push(ev('tool_end', { node_id: `n${i}`, tool: 'fetch' }));
    }
    events.push(ev('end'));
    feed(hub, events);

    render(<TaskPanel bindValue={hub.getSnapshot().taskState} />);
    expect(screen.getByText('执行面板')).toBeInTheDocument();
    // 步进计数
    expect(screen.getByText(/步进 3\/3/)).toBeInTheDocument();
    expect(screen.getByText(/剩余 0/)).toBeInTheDocument();
    // 三行子任务终态
    expect(screen.getAllByText('完成')).toHaveLength(3);
    expect(screen.getByText('子任务0')).toBeInTheDocument();
    expect(screen.getByText('子任务2')).toBeInTheDocument();
  });

  it('无 plan 时子任务仅在 spawn 后可见，且不粘连事件流', () => {
    const hub = new ChannelHub();
    feed(hub, [
      ev('spawn_start', { node_id: 'x', label: '展开甲' }),
      ev('spawn_end', { node_id: 'x' }),
    ]);
    render(<TaskPanel bindValue={hub.getSnapshot().taskState} />);
    expect(screen.getByText('展开甲')).toBeInTheDocument();
    expect(screen.getByText('完成')).toBeInTheDocument();
    expect(screen.getByText(/子任务 1 行/)).toBeInTheDocument();
  });

  it('缺字段降级：spawn_start 无 key/label 仍渲染运行态', () => {
    const hub = new ChannelHub();
    feed(hub, [ev('spawn_start', {})]);
    render(<TaskPanel bindValue={hub.getSnapshot().taskState} />);
    expect(screen.getByText('运行中')).toBeInTheDocument();
  });

  it('bindValue 缺失显示空态不崩', () => {
    render(<TaskPanel />);
    expect(screen.getByText(/暂无任务执行/)).toBeInTheDocument();
  });

  it('bindValue 形态损坏（无 subtasks）回落空态不崩', () => {
    render(<TaskPanel bindValue={{ stepsTotal: 2 }} />);
    expect(screen.getByText(/暂无任务执行/)).toBeInTheDocument();
  });
});
