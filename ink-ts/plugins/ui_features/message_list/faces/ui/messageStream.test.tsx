import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageStream } from './MessageStream';

describe('MessageStream', () => {
  it('renders empty state when no entries', () => {
    render(<MessageStream entries={[]} streaming={false} />);
    expect(screen.getByText('开始你的第一个任务')).toBeTruthy();
  });

  it('renders user bubble', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'text', role: 'user', content: 'hello', roundId: 'r1' }]} streaming={false} />);
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('renders assistant text with streaming cursor', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'streaming', content: 'hi', roundId: 'r1' }]} streaming />);
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('renders speaker label when assistant text carries name', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'text', role: 'assistant', content: '评审意见', name: '安全评审', roundId: 'r1' }]} streaming={false} />);
    expect(screen.getByText('评审意见')).toBeTruthy();
    expect(screen.getByText('安全评审')).toBeTruthy();
  });

  it('renders speaker label on streaming collaborator reply', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'streaming', content: '分析中', name: '研究分析师', roundId: 'r1' }]} streaming />);
    expect(screen.getByText('分析中')).toBeTruthy();
    expect(screen.getByText('研究分析师')).toBeTruthy();
  });

  it('renders system text message', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'text', role: 'system', content: '回合结束', roundId: 'r1' }]} streaming={false} />);
    expect(screen.getByText('回合结束')).toBeTruthy();
  });

  it('renders error card', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'error', content: '执行异常', roundId: 'r1' }]} streaming={false} />);
    expect(screen.getByText('执行异常')).toBeTruthy();
  });

  it('renders phase capsule when roundSteps provided', () => {
    render(
      <MessageStream
        entries={[]}
        streaming={false}
        roundSteps={[{ stepId: 's1', type: 'tool', label: 'grep', status: 'running', startedAt: Date.now() }]}
        
      />,
    );
    expect(screen.getByText('阶段')).toBeTruthy();
    fireEvent.click(screen.getByText('展开'));
    expect(screen.getByText('grep')).toBeTruthy();
  });

  it('renders pulse line when pulseText provided', () => {
    render(<MessageStream entries={[]} streaming={false} pulseText="正在思考…" pulseColor="approval" />);
    expect(screen.getByText('正在思考…')).toBeTruthy();
  });

  it('renders tool card with expand/collapse', () => {
    render(<MessageStream entries={[{ id: '1', kind: 'tool', tool: 'grep', permission: '', toolStatus: 'done', summary: '命中 3 处', roundId: 'r1' }]} streaming={false} />);
    expect(screen.getByText('grep')).toBeTruthy();
    fireEvent.click(screen.getByText('详情'));
    expect(screen.getByText('收起')).toBeTruthy();
    expect(screen.getByText('输出')).toBeTruthy();
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
        
      />,
    );
    expect(screen.getByText('子任务 1')).toBeTruthy();
  });

  it('renders knowledge hit card inline', () => {
    render(
      <MessageStream
        entries={[{ id: '1', kind: 'knowledge_hit', hits: [{ id: 'k1', title: '记忆甲', snippet: '摘要' }], roundId: 'r1' }]}
        streaming={false}
        
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
        
      />,
    );
    expect(screen.getByText('已通过审查')).toBeTruthy();
  });

  it('auto 轮（roundId 前缀 auto:）首条消息前渲染「自动续跑」徽标；同轮后续行不重复', () => {
    const { container } = render(
      <MessageStream
        entries={[
          { id: '1', kind: 'thinking', content: '继续推理', status: 'completed', roundId: 'auto:k-1' },
          { id: '2', kind: 'tool', tool: 'inspect', permission: '', toolStatus: 'done', summary: 'ok', roundId: 'auto:k-1' },
          { id: '3', kind: 'text', role: 'assistant', content: '继续推进', roundId: 'auto:k-1' },
        ]}
        streaming={false}
        
      />,
    );
    expect(container.querySelectorAll('[data-ui="auto_round_marker"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-auto-round]')).toHaveLength(1);
    expect(screen.getAllByText('自动续跑')).toHaveLength(1);
    expect(screen.getByText('继续推进')).toBeTruthy();
  });

  it('普通轮（非 auto: 前缀）消息不渲染 auto 徽标', () => {
    const { container } = render(
      <MessageStream
        entries={[
          { id: '1', kind: 'text', role: 'user', content: 'hi', roundId: 'r1' },
          { id: '2', kind: 'text', role: 'assistant', content: 'hello', roundId: 'r1' },
        ]}
        streaming={false}
        
      />,
    );
    expect(container.querySelectorAll('[data-ui="auto_round_marker"]')).toHaveLength(0);
    expect(screen.queryByText('自动续跑')).toBeNull();
  });

  it('普通轮转入 auto 轮：徽标只出现在 auto 轮首条边界', () => {
    const { container } = render(
      <MessageStream
        entries={[
          { id: '1', kind: 'text', role: 'user', content: 'hi', roundId: 'r1' },
          { id: '2', kind: 'text', role: 'assistant', content: '分析', roundId: 'r1' },
          { id: '3', kind: 'text', role: 'assistant', content: '自动续跑一段', roundId: 'auto:k-2' },
          { id: '4', kind: 'tool', tool: 'apply_patch', permission: '', toolStatus: 'done', roundId: 'auto:k-2' },
        ]}
        streaming={false}
        
      />,
    );
    expect(container.querySelectorAll('[data-ui="auto_round_marker"]')).toHaveLength(1);
    expect(screen.getAllByText('自动续跑')).toHaveLength(1);
  });

  it('连续两个 auto 轮（各自首条）分别渲染徽标', () => {
    const { container } = render(
      <MessageStream
        entries={[
          { id: '1', kind: 'text', role: 'assistant', content: '续跑 A', roundId: 'auto:k-a' },
          { id: '2', kind: 'text', role: 'assistant', content: '续跑 B', roundId: 'auto:k-b' },
        ]}
        streaming={false}
        
      />,
    );
    expect(container.querySelectorAll('[data-ui="auto_round_marker"]')).toHaveLength(2);
  });
});
