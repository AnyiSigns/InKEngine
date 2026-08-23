/**
 * 消息流呈现规范测试：事件→渲染器一对一、三级视觉层、流式节流绘制、
 * 中途事件可见、虚拟化、收起仅视觉、乱序按事件序、工具族语义行。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageList } from '@/components/message_list';
import type { InkMessage } from '@/shared/session/types';

describe('一对一映射：每条消息一个独立条目', () => {
  it('thinking/tool 各自成条（不拼接为状态行）', () => {
    const messages: InkMessage[] = [
      { id: 't1', kind: 'thinking', content: '推理内容', status: 'completed' },
      { id: 't2', kind: 'tool', tool: 'inspect_knowledge', permission: 'allow', toolStatus: 'done', summary: '2 条知识' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    const toolRaw = screen.getByText(/inspect_knowledge · allow/);
    expect(toolRaw).toBeInTheDocument();
    // 思考条目头部独立存在
    expect(screen.getByText('思考')).toBeInTheDocument();
  });

  it('知识命中/建议/设备/错误各自独立条目渲染', () => {
    const messages: InkMessage[] = [
      { id: 'k1', kind: 'knowledge_hit', hits: [{ id: 'k-1', title: '条目甲', snippet: '片段' }] },
      { id: 's1', kind: 'suggestions', items: ['item-a'] },
      { id: 'd1', kind: 'device', action: 'notify', detail: '通知已发送' },
      { id: 'e1', kind: 'error', content: '回合中断' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(screen.getByText('检索命中')).toBeInTheDocument();
    expect(screen.getByText('#item-a')).toBeInTheDocument();
    expect(screen.getByText(/设备：notify/)).toBeInTheDocument();
    expect(screen.getByText('回合中断')).toBeInTheDocument();
  });

  it('乱序流按事件序（绑定值顺序）渲染，不按 stepId 重排', () => {
    const messages: InkMessage[] = [
      { id: 'b', kind: 'text', role: 'assistant', content: '第二条' },
      { id: 'a', kind: 'text', role: 'user', content: '第一条' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    const listEl = document.querySelector('[data-ui="message_list"]');
    const text = listEl?.textContent ?? '';
    expect(text.indexOf('第二条')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('第二条')).toBeLessThan(text.indexOf('第一条'));
  });
});

describe('三级视觉层', () => {
  it('正文消息走不透明气泡（ink-bubble-user / 纸面正文）', () => {
    const messages: InkMessage[] = [
      { id: 'u1', kind: 'text', role: 'user', content: '用户消息' },
      { id: 'a1', kind: 'text', role: 'assistant', content: '领域观察中' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(screen.getByText('用户消息').className).toContain('ink-bubble-user');
    expect(screen.getByText('领域观察中').closest('.ink-markdown')).not.toBeNull();
  });

  it('状态消息气泡半透明（ink-status-bubble）+ 状态卡片透明（ink-status-card）', () => {
    const messages: InkMessage[] = [
      { id: 't1', kind: 'tool', tool: 'file_read', permission: 'allow', toolStatus: 'done', summary: 'ok' },
      { id: 'th1', kind: 'thinking', content: '推理', status: 'completed' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    const toolBubble = screen.getByText('读取文件').closest('.ink-status-bubble');
    expect(toolBubble).not.toBeNull();
    const thinkingCard = screen.getByText('思考').closest('.ink-status-card');
    expect(thinkingCard).not.toBeNull();
    expect(thinkingCard?.className).not.toContain('ink-status-bubble');
  });
});

describe('流式绘制（节流只压重绘、不改变事件序）', () => {
  it('streaming token 逐片追加（节流关闭时直绘）', () => {
    const messages: InkMessage[] = [
      { id: 'st1', kind: 'streaming', content: '正在' },
    ];
    const { rerender } = render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    let text = screen.getByText(/正在/);
    expect(text).toBeInTheDocument();
    rerender(<MessageList bindValue={[{ id: 'st1', kind: 'streaming', content: '正在生成' }]} throttleMs={0} viewportHeight={400} />);
    text = screen.getByText(/正在生成/);
    expect(text).toBeInTheDocument();
  });

  it('推理流式：中途 token 可见（thinking_start 分片）', async () => {
    const user = userEvent.setup();
    const messages: InkMessage[] = [
      { id: 'th1', kind: 'thinking', content: '观察当前领域的', status: 'running' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    // 蓄力区默认收起（头部实时可见），展开后内容可见
    expect(screen.getByText('推理中')).toBeInTheDocument();
    await user.click(screen.getByText('思考'));
    expect(screen.getByText(/观察当前领域的/)).toBeInTheDocument();
  });
});

describe('长列表虚拟化', () => {
  it('仅渲染窗口行 + 上下缓冲（数据序不变）', () => {
    const messages: InkMessage[] = Array.from({ length: 300 }, (_, index) => ({
      id: `v${index}`,
      kind: 'text' as const,
      role: 'user' as const,
      content: `虚拟行 ${index}`,
    }));
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={150} estimatedHeight={30} />);
    // 初始贴底窗口：尾部行在 DOM，中部行不在
    expect(screen.getByText('虚拟行 299')).toBeInTheDocument();
    expect(screen.queryByText('虚拟行 0')).not.toBeInTheDocument();
    expect(screen.queryByText('虚拟行 150')).not.toBeInTheDocument();
  });
});

describe('折叠（收起仅视觉）', () => {
  it('条目收起隐藏主体；数据不变；重渲染保持收起', async () => {
    const user = userEvent.setup();
    const messages: InkMessage[] = [
      { id: 't1', kind: 'tool', tool: 'file_read', permission: 'allow', toolStatus: 'done', summary: 'ok', args: '{"path":"/a"}' },
    ];
    const { rerender } = render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(screen.getByText('原始参数')).toBeInTheDocument();
    const collapseButtons = document.querySelectorAll('[data-ui="entry_collapse"]');
    await user.click(collapseButtons[0]);
    expect(screen.queryByText('原始参数')).not.toBeInTheDocument();
    rerender(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(screen.queryByText('原始参数')).not.toBeInTheDocument();
    const expandButtons = document.querySelectorAll('[data-ui="entry_expand"]');
    await user.click(expandButtons[0]);
    expect(screen.getByText('原始参数')).toBeInTheDocument();
  });
});

describe('工具条目：族语义 + 原始参数不裸 JSON', () => {
  it('OS 族 = 动作+目标+结果（语义行）', () => {
    const messages: InkMessage[] = [
      { id: 'os1', kind: 'tool', tool: 'launch_app', permission: 'review', toolStatus: 'done', summary: '已启动', args: '{"app":"绘图板"}' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(screen.getByText('启动应用')).toBeInTheDocument();
    expect(screen.getByText('待审批')).toBeInTheDocument();
    expect(screen.getByText('目标')).toBeInTheDocument();
    expect(screen.getByText('绘图板')).toBeInTheDocument();
    expect(screen.getByText('结果')).toBeInTheDocument();
    expect(screen.getByText('已启动')).toBeInTheDocument();
  });

  it('权限档中文 + 原始参数可展开（格式化 JSON 而非裸行）', async () => {
    const user = userEvent.setup();
    const messages: InkMessage[] = [
      { id: 'f1', kind: 'tool', tool: 'file_write', permission: 'deny', toolStatus: 'error', summary: '拒绝写入', args: '{"path":"/etc/x"}' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
    expect(screen.getByText('写入文件')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    const argsToggle = screen.getByText('原始参数');
    await user.click(argsToggle);
    expect(screen.getByText(/"path":"\/etc\/x"/)).toBeInTheDocument();
  });
});
