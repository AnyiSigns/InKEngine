/**
 * 组件行为测试：消息流增量渲染 / 审批卡弹层与决议 / 推演换选 / 设置页试穿。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageList } from '@/components/message_list';
import { ReviewCard } from '@/components/review_card';
import { SimulationTree } from '@/components/simulation_tree';
import { SettingsForm } from '@/components/settings_form';
import { ChannelHub } from '@/shared/session/channelHub';
import type { HubEvent } from '@/shared/session/channelHub';

function ev(type: HubEvent['type'], payload: Record<string, unknown> = {}): HubEvent {
  return { type, payload, at: Date.now() };
}

describe('message_list：流式/思考/工具内联行', () => {
  it('空数据态', () => {
    render(<MessageList bindValue={[]} />);
    expect(screen.getByText(/消息流为空/)).toBeInTheDocument();
  });

  it('长消息流增量渲染：超出窗口只渲染尾部并提示', () => {
    const messages = Array.from({ length: 260 }, (_, index) => ({
      id: `m${index}`,
      kind: 'text' as const,
      role: 'user' as const,
      content: `消息 ${index}`,
    }));
    render(<MessageList bindValue={messages} tailWindow={200} />);
    expect(screen.getByText(/仅显示最近 200 条消息（共 260 条）/)).toBeInTheDocument();
    expect(screen.getByText('消息 259')).toBeInTheDocument();
    expect(screen.queryByText('消息 0')).not.toBeInTheDocument();
  });

  it('工具调用内联行：工具名 · 权限判定 · 结果摘要', () => {
    const messages = [
      { id: 't1', kind: 'tool' as const, tool: 'inspect_knowledge', permission: 'allow', toolStatus: 'done' as const, summary: '2 条知识' },
    ];
    render(<MessageList bindValue={messages} />);
    expect(screen.getByText(/inspect_knowledge · allow/)).toBeInTheDocument();
    expect(screen.getByText('2 条知识')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('思考卡可折叠展开', async () => {
    const user = userEvent.setup();
    const messages = [
      { id: 'th1', kind: 'thinking' as const, content: '观察当前领域的知识缺口', status: 'completed' as const },
    ];
    render(<MessageList bindValue={messages} />);
    expect(screen.queryByText('观察当前领域的知识缺口')).not.toBeInTheDocument();
    await user.click(screen.getByText(/思考/));
    expect(screen.getByText('观察当前领域的知识缺口')).toBeInTheDocument();
  });
});

describe('review_card：居中弹层（朱砂 accent，任何视图可弹）', () => {
  it('无事件不弹层', () => {
    render(<ReviewCard bindValue={undefined} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('审批事件到达即弹层，accept 决议回调', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const hub = new ChannelHub();
    hub.dispatch(ev('review_card', { title: '补丁审批', reason: '请求应用规则补丁' }));
    render(<ReviewCard bindValue={hub.getLastEvent('review_card')} onResolve={onResolve} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('补丁审批')).toBeInTheDocument();

    await user.click(screen.getByText('确认'));
    expect(onResolve).toHaveBeenCalledWith('accept', undefined, undefined);
    // 决议后关闭弹层
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reject / edit 决议路径可用', async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    const hub = new ChannelHub();
    hub.dispatch(ev('review_card', { title: '审批', content: '可编辑内容' }));
    const { rerender } = render(<ReviewCard bindValue={hub.getLastEvent('review_card')} onResolve={onResolve} />);

    await user.click(screen.getByText('拒绝'));
    expect(onResolve).toHaveBeenCalledWith('reject', undefined, undefined);

    hub.dispatch(ev('review_card', { title: '审批', content: '可编辑内容' }));
    rerender(<ReviewCard bindValue={hub.getLastEvent('review_card')} onResolve={onResolve} />);
    await user.click(screen.getByText('编辑'));
    await user.type(screen.getByRole('textbox'), '追加');
    await user.click(screen.getByText('提交修改'));
    expect(onResolve).toHaveBeenCalledWith('edit', expect.stringContaining('可编辑内容'), undefined);
  });
});

describe('simulation_tree：分支对比 + 换选', () => {
  it('分支渲染与换选回调', async () => {
    const user = userEvent.setup();
    const onSwap = vi.fn();
    const branches = [
      { branchId: 'b-1', label: '直接沉淀', score: 0.82, selected: true, steps: [] },
      { branchId: 'b-2', label: '先孵化', score: 0.74, selected: false, steps: [] },
    ];
    render(<SimulationTree bindValue={branches} onSwapBranch={onSwap} />);
    expect(screen.getByText('直接沉淀')).toBeInTheDocument();
    expect(screen.getByText('评分 0.82')).toBeInTheDocument();
    await user.click(screen.getByText('换选'));
    expect(onSwap).toHaveBeenCalledWith('b-2');
  });

  it('空数据态', () => {
    render(<SimulationTree bindValue={[]} />);
    expect(screen.getByText(/暂无推演/)).toBeInTheDocument();
  });
});

describe('settings_form：双栏导航 + 主题 token 试穿再应用（白名单内）', () => {
  it('白名单 token 可编辑，试穿即时落地 CSS 变量', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    await user.click(screen.getByRole('button', { name: /外观/ }));
    const input = screen.getByLabelText('bg.base 色值');
    await user.clear(input);
    await user.type(input, '#101014');
    // 试穿生效（白名单 token → CSS 变量）
    expect(document.documentElement.style.getPropertyValue('--ink-bg-base')).toBe('#101014');
  });

  it('双挡位模型配置表单渲染（默认分区）', () => {
    render(<SettingsForm />);
    expect(screen.getByText('router')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('MCP 市场挂载管理（出厂零预挂 → 一键挂载）', async () => {
    const user = userEvent.setup();
    render(<SettingsForm />);
    await user.click(screen.getByRole('button', { name: /连接/ }));
    expect(screen.getByText(/mcp_market 市场（出厂零预挂/)).toBeInTheDocument();
    const mountButtons = screen.getAllByText('挂载');
    await user.click(mountButtons[0]);
    expect(screen.getByText(/已挂载：web_search/)).toBeInTheDocument();
  });
});
