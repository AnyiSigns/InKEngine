/**
 * 渲染器三层白名单测试：未声明组件 / 绑定通道 / 主题 token 拒绝渲染。
 *
 * 绑定面以 registered test component（test_list，注册即白名单放行）替代
 * 产品组件——本套测试验证渲染器白名单机制，不耦合具体产品组件内容。
 */

import { render, screen } from '@testing-library/react';

import { ChannelHub } from '@/shared/session/channelHub';
import { registerComponent } from '@/renderer/componentRegistry';
import { bindChannelWhitelist, isBindChannelAllowed } from '@/renderer/channelWhitelist';
import { applyThemeTokens, rejectedThemeTokens, THEME_TOKEN_DEFAULTS } from '@/renderer/themeTokens';
import { UIRenderer } from '@/renderer/bootRenderer';
import type { UISpec } from '@/renderer/uiSpecTypes';

function makeSpec(overrides: Partial<UISpec> = {}): UISpec {
  return {
    name: 'test.ui',
    version: 1,
    theme: { ...THEME_TOKEN_DEFAULTS },
    root: {
      kind: 'container',
      type: 'column',
      children: [
        { kind: 'component', type: 'test_list', bind: { channel: 'state.messages', path: '' } },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  registerComponent('test_list', ({ bindValue }: { bindValue?: unknown }) => (
    <div>
      {Array.isArray(bindValue) && bindValue.length > 0
        ? bindValue.map((m, index) => (
            <div key={index}>{(m as { content?: string }).content ?? (m as { id?: string }).id ?? '条目'}</div>
          ))
        : '空态占位'}
    </div>
  ));
});

describe('一层防线：未声明组件拒绝渲染', () => {
  it('未注册组件渲染占位拒绝，不执行', () => {
    const spec = makeSpec({
      root: {
        kind: 'container',
        type: 'column',
        children: [{ kind: 'component', type: 'not_registered_anywhere' }],
      },
    });
    render(<UIRenderer spec={spec} hub={new ChannelHub()} />);
    expect(screen.getByText(/未注册组件：not_registered_anywhere/)).toBeInTheDocument();
  });

  it('注册组件正常渲染（注册即白名单放行）', () => {
    render(<UIRenderer spec={makeSpec()} hub={new ChannelHub()} />);
    expect(screen.getByText('空态占位')).toBeInTheDocument();
  });
});

describe('二层防线：绑定通道白名单拒绝', () => {
  it('未放行通道拒绝绑定并整组件拒绝渲染', () => {
    const spec = makeSpec({
      root: {
        kind: 'container',
        type: 'column',
        children: [
          { kind: 'component', type: 'test_list', bind: { channel: 'state.unknown_channel', path: '' } },
        ],
      },
    });
    render(<UIRenderer spec={spec} hub={new ChannelHub()} />);
    expect(screen.getByText(/绑定通道未放行：state.unknown_channel/)).toBeInTheDocument();
  });

  it('_ 前缀内部通道禁绑（防信息泄漏）', () => {
    const spec = makeSpec({
      root: {
        kind: 'container',
        type: 'column',
        children: [
          { kind: 'component', type: 'test_list', bind: { channel: '_internal.state', path: '' } },
        ],
      },
    });
    render(<UIRenderer spec={spec} hub={new ChannelHub()} />);
    expect(screen.getByText(/绑定通道禁绑：_internal.state/)).toBeInTheDocument();
  });

  it('_ 前缀路径段拒绝（state.messages 白名单内但路径越界）', () => {
    const spec = makeSpec({
      root: {
        kind: 'container',
        type: 'column',
        children: [
          { kind: 'component', type: 'test_list', bind: { channel: 'state.messages', path: '_secret' } },
        ],
      },
    });
    render(<UIRenderer spec={spec} hub={new ChannelHub()} />);
    expect(screen.getByText(/绑定通道未放行/)).toBeInTheDocument();
  });

  it('events.* 通道细粒度白名单：未登记事件类型拒绝', () => {
    expect(isBindChannelAllowed('events.reply_token')).toBe(true);
    expect(isBindChannelAllowed('events.unknown_event_xyz')).toBe(false);
  });

  it('inspect_* 五元快照通道放行（inspect_graph 随组装链路退役拒绝，W7-B），未知快照通道拒绝', () => {
    expect(isBindChannelAllowed('inspect_rules')).toBe(true);
    expect(isBindChannelAllowed('inspect_graph')).toBe(false);
    expect(isBindChannelAllowed('inspect_tools')).toBe(true);
    expect(isBindChannelAllowed('inspect_entities')).toBe(true);
    expect(isBindChannelAllowed('inspect_secret')).toBe(false);
  });

  it('state.* camelCase 快照键（roundSteps/taskState）放行', () => {
    expect(isBindChannelAllowed('state.roundSteps')).toBe(true);
    expect(isBindChannelAllowed('state.taskState')).toBe(true);
    expect(isBindChannelAllowed('state.round_steps')).toBe(true);
    expect(isBindChannelAllowed('state.notAField')).toBe(false);
  });
});

describe('三层防线：主题 token 白名单拒绝', () => {
  it('白名单状态组 token 落地 CSS 变量', () => {
    const root = document.documentElement;
    const cleanup = applyThemeTokens({
      'status.bubble.fill': 'color-mix(in srgb, red 50%, transparent)',
      'status.bubble.edge': 'color-mix(in srgb, red 60%, transparent)',
      'status.card.edge': 'color-mix(in srgb, red 70%, transparent)',
    });
    expect(root.style.getPropertyValue('--ink-status-bubble-fill')).toBe('color-mix(in srgb, red 50%, transparent)');
    expect(root.style.getPropertyValue('--ink-status-bubble-edge')).toBe('color-mix(in srgb, red 60%, transparent)');
    expect(root.style.getPropertyValue('--ink-status-card-edge')).toBe('color-mix(in srgb, red 70%, transparent)');
    cleanup();
  });

  it('基础组 token（bg.base/text.base/accent.approval）归档位层，不内联落地', () => {
    const root = document.documentElement;
    const cleanup = applyThemeTokens({ 'bg.base': '#111111', 'text.base': '#dddddd', 'accent.approval': '#ffaa00' });
    expect(root.style.getPropertyValue('--ink-bg-base')).toBe('');
    expect(root.style.getPropertyValue('--ink-text-base')).toBe('');
    expect(root.style.getPropertyValue('--ink-accent-approval')).toBe('');
    cleanup();
  });

  it('未声明 token 拒绝落地（不写 CSS 变量）', () => {
    const root = document.documentElement;
    const cleanup = applyThemeTokens({ 'evil.token': '#000000', 'status.bubble.fill': 'color-mix(in srgb, red 40%, transparent)' });
    expect(root.style.getPropertyValue('--ink-evil-token')).toBe('');
    expect(root.style.getPropertyValue('--ink-status-bubble-fill')).toBe('color-mix(in srgb, red 40%, transparent)');
    cleanup();
  });

  it('rejectedThemeTokens 列出白名单外 token（外观面板提示用）', () => {
    expect(rejectedThemeTokens({ 'evil.token': '#000' })).toEqual(['evil.token']);
    expect(rejectedThemeTokens({ 'bg.base': '#000' })).toEqual([]);
  });

  it('损坏 theme 形态（非对象）不影响渲染（normalize 兜底）', () => {
    const spec = makeSpec();
    const bad = { ...spec, theme: 'oops' as unknown as Record<string, string> };
    render(<UIRenderer spec={bad} hub={new ChannelHub()} />);
    expect(screen.getByText(/已回落基线布局/)).toBeInTheDocument();
  });
});

describe('损坏 ui_spec 回落基线不崩溃', () => {
  it('root 缺失回落基线布局', () => {
    render(<UIRenderer spec={makeSpec({ root: null })} hub={new ChannelHub()} />);
    expect(screen.getByText(/已回落基线布局/)).toBeInTheDocument();
  });

  it('根节点字段类型损坏回落基线', () => {
    const spec = makeSpec({
      root: { kind: 'container', type: 'column', children: 'not-an-array' } as never,
    });
    render(<UIRenderer spec={spec} hub={new ChannelHub()} />);
    expect(screen.getByText(/已回落基线布局/)).toBeInTheDocument();
  });

  it('spec 非对象形态（null/字符串）回落基线', () => {
    render(<UIRenderer spec={null} hub={new ChannelHub()} />);
    expect(screen.getByText(/已回落基线布局/)).toBeInTheDocument();
  });

  it('bind 结构损坏（channel 非字符串）回落基线', () => {
    const spec = makeSpec({
      root: {
        kind: 'container',
        type: 'column',
        children: [
          { kind: 'component', type: 'test_list', bind: { channel: 42 } } as never,
        ],
      },
    });
    render(<UIRenderer spec={spec} hub={new ChannelHub()} />);
    expect(screen.getByText(/已回落基线布局/)).toBeInTheDocument();
  });
});

describe('绑定协议直渲', () => {
  it('state.messages 绑定组件渲染会话消息（hub 注入）', () => {
    const hub = new ChannelHub();
    hub.setState({
      messages: [
        { id: 'm1', kind: 'text', role: 'user', content: '你好 InKling' },
        { id: 'm2', kind: 'text', role: 'assistant', content: '领域观察中' },
      ],
    });
    render(<UIRenderer spec={makeSpec()} hub={hub} />);
    expect(screen.getByText('你好 InKling')).toBeInTheDocument();
    expect(screen.getByText('领域观察中')).toBeInTheDocument();
  });

  it('无 hub 时绑定组件显示空态不崩', () => {
    render(<UIRenderer spec={makeSpec()} hub={null} />);
    expect(screen.getByText('空态占位')).toBeInTheDocument();
  });
});

describe('动态注册与覆盖', () => {
  it('动态注册组件后白名单放行', () => {
    const spec = makeSpec({
      root: {
        kind: 'container',
        type: 'column',
        children: [{ kind: 'component', type: 'dyn_test' }],
      },
    });
    render(<UIRenderer spec={spec} hub={new ChannelHub()} />);
    expect(screen.getByText(/未注册组件：dyn_test/)).toBeInTheDocument();

    registerComponent('dyn_test', () => <div>动态组件已注册</div>);
    render(<UIRenderer spec={spec} hub={new ChannelHub()} />);
    expect(screen.getByText('动态组件已注册')).toBeInTheDocument();
  });
});

describe('task_state 子通道（纯追加）', () => {
  it('state.taskState 白名单放行且列入清单', () => {
    expect(isBindChannelAllowed('state.taskState')).toBe(true);
    const list = bindChannelWhitelist();
    expect(list).toContain('state.taskState');
  });
});
