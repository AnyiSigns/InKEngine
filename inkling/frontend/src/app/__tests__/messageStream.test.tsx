import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageStream } from '../session/MessageStream';

describe('MessageStream', () => {
  it('renders empty state when no entries', () => {
    render(<MessageStream entries={[]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('开始你的第一个任务')).toBeTruthy();
  });

  it('renders user bubble', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'text', role: 'user', content: 'hello', roundId: 'r1' }]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('renders assistant text with streaming cursor', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'streaming', content: 'hi', roundId: 'r1' }]} streaming onBranchFromMessage={() => {}} />);
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('renders speaker label when assistant text carries name', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'text', role: 'assistant', content: '评审意见', name: '安全评审', roundId: 'r1' }]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('评审意见')).toBeTruthy();
    expect(screen.getByText('安全评审')).toBeTruthy();
  });

  it('renders speaker label on streaming collaborator reply', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'streaming', content: '分析中', name: '研究分析师', roundId: 'r1' }]} streaming onBranchFromMessage={() => {}} />);
    expect(screen.getByText('分析中')).toBeTruthy();
    expect(screen.getByText('研究分析师')).toBeTruthy();
  });

  it('renders system text message', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'text', role: 'system', content: '回合结束', roundId: 'r1' }]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('回合结束')).toBeTruthy();
  });

  it('renders error card', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'error', content: '执行异常', roundId: 'r1' }]} streaming={false} onBranchFromMessage={() => {}} />);
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
    render(<MessageStream entries={[{ id: '1', kind: 'tool', tool: 'grep', permission: '', toolStatus: 'done', summary: '命中 3 处', roundId: 'r1' }]} streaming={false} onBranchFromMessage={() => {}} />);
    expect(screen.getByText('grep')).toBeTruthy();
    fireEvent.click(screen.getByText('查看参数'));
    expect(screen.getByText('收起')).toBeTruthy();
  });

  it('renders spawn card and opens panel', () => {
    render(
      <MessageStream
        entries={[{ id: '1', kind: 'spawn', status: 'running', label: '子任务 1', roundId: 'r1' }]}
        streaming={false}
        spawnInstances={[{ index: 0, label: '子任务 1', status: 'running' }]}
        onSpawnSelect={() => {}}
        selectedSpawnIndex={null}
        onSpawnSendInstruction={() => {}}
        spawnStreaming={false}
        onBranchFromMessage={() => {}}
      />,
    );
    expect(screen.getByText('子任务 1')).toBeTruthy();
  });

  it('renders knowledge hit card inline', () => {
    render(
      <MessageStream
        entries={[{ id: '1', kind: 'knowledge_hit', hits: [{ id: 'k1', title: '记忆甲', snippet: '摘要' }], roundId: 'r1' }]}
        streaming={false}
        onBranchFromMessage={() => {}}
      />,
    );
    expect(screen.getByText(/知识检索 · 已放行 · 1 条相关记忆/)).toBeTruthy();
    expect(screen.getByText('记忆甲')).toBeTruthy();
  });

  it('renders device card inline', () => {
    render(
      <MessageStream
        entries={[{ id: '1', kind: 'device', action: 'read_file', detail: '/tmp/a.txt', roundId: 'r1' }]}
        streaming={false}
        onBranchFromMessage={() => {}}
      />,
    );
    expect(screen.getByText('设备操作')).toBeTruthy();
    expect(screen.getByText('read_file')).toBeTruthy();
  });

  it('renders vetting card inline', () => {
    render(
      <MessageStream
        entries={[{ id: '1', kind: 'vetting', tool: 'shell', verdict: 'pass', roundId: 'r1' }]}
        streaming={false}
        onBranchFromMessage={() => {}}
      />,
    );
    expect(screen.getByText('已通过审查')).toBeTruthy();
  });
});
