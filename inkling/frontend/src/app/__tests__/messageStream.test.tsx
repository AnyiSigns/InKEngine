import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageStream } from '../session/MessageStream';

describe('MessageStream', () => {
  it('renders empty state when no entries', () => {
    render(<MessageStream entries={[]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('开始你的第一个任务')).toBeTruthy();
  });

  it('renders user bubble', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'user', content: 'hello', at: Date.now() }]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('renders assistant text with streaming cursor', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'assistant', content: 'hi', at: Date.now() }]} streaming onBranchFromMessage={() => {}} />);
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('renders system end event', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'system', content: '回合结束', at: Date.now() }]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('回合结束')).toBeTruthy();
  });

  it('renders error card', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'error', content: '执行异常', at: Date.now() }]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('执行异常')).toBeTruthy();
  });

  it('renders phase capsule when roundSteps provided', () => {
    render(
      <MessageStream
        entries={[]}
        streaming={false}
        roundSteps={[{ stepId: 's1', type: 'tool', label: 'grep', status: 'running', startedAt: Date.now() }]}
        onBranchFromMessage={() => {}}
      />,
    );
    expect(screen.getByText('阶段')).toBeTruthy();
    fireEvent.click(screen.getByText('展开'));
    expect(screen.getByText('grep')).toBeTruthy();
  });

  it('renders pulse line when pulseText provided', () => {
    render(<MessageStream entries={[]} streaming={false} pulseText="正在思考…" pulseColor="approval" onBranchFromMessage={() => {}} />);
    expect(screen.getByText('正在思考…')).toBeTruthy();
  });

  it('renders tool card with expand/collapse', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'tool', content: 'output', meta: { toolName: 'grep', status: 'ok', summary: '命中 3 处' } }]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('grep')).toBeTruthy();
    fireEvent.click(screen.getByText('查看输出'));
    expect(screen.getByText('收起')).toBeTruthy();
  });

  it('renders spawn card and opens panel', () => {
    render(
      <MessageStream
        entries={[{ id: '1', kind: 'spawn', meta: { count: 2 } }]}
        streaming={false}
        spawnInstances={[{ index: 0, label: '子任务 1', status: 'running' }]}
        onSpawnSelect={() => {}}
        selectedSpawnIndex={null}
        onSpawnSendInstruction={() => {}}
        spawnStreaming={false}
        onBranchFromMessage={() => {}}
      />,
    );
    expect(screen.getByText('子代理 · 2 个实例')).toBeTruthy();
    fireEvent.click(screen.getByText('打开面板'));
    expect(screen.getByText('子代理实例')).toBeTruthy();
  });
});
