/**
 * 页面布局重构验收：设置页 Tab 化（每 tab 只渲染对应 form）、深看摘要条
 * 收敛、孤儿组件归位（注册表 ↔ ui_spec 引用）、缺视图可导航/可渲染、
 * 未知 tab / 未知视图回落不崩。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { registerBuiltinComponents } from '@/components';
import { isComponentRegistered } from '@/renderer/componentRegistry';
import { UIRenderer } from '@/renderer/bootRenderer';
import { SummaryBar } from '@/components/summary_bar';
import { SettingsForm } from '@/components/settings_form';
import { ChannelHub } from '@/shared/session/channelHub';
import type { UINode, UISpec } from '@/renderer/uiSpecTypes';
import fixtureSpec from '@/data/ui_spec.fixture.json';

function collectComponentTypes(node: UINode, acc: Set<string>): void {
  if (node.kind === 'component') acc.add(node.type);
  for (const child of node.children ?? []) collectComponentTypes(child, acc);
}

const ORPHAN_COMPONENTS = [
  'file_tree',
  'view_header',
  'session_list',
  'admin_console',
  'admin_tools',
  'architecture_view',
  'ui_spec_editor',
];

beforeEach(() => {
  registerBuiltinComponents();
});

describe('设置页 Tab 化（每 tab 只渲染对应 form）', () => {
  it('默认激活首个 tab，仅渲染该分区内容', () => {
    render(<UIRenderer spec={fixtureSpec as unknown as UISpec} hub={new ChannelHub()} activeView="settings" />);
    expect(screen.getByText('创建容器前必须人工审批（fail-closed）')).toBeInTheDocument();
    expect(screen.queryByText('router')).not.toBeInTheDocument();
  });

  it('切换 tab 后仅渲染目标分区，其余分区移出', async () => {
    const user = userEvent.setup();
    render(<UIRenderer spec={fixtureSpec as unknown as UISpec} hub={new ChannelHub()} activeView="settings" />);
    await user.click(screen.getByRole('button', { name: '应用能力' }));
    expect(screen.getByText('router')).toBeInTheDocument();
    expect(screen.queryByText('创建容器前必须人工审批（fail-closed）')).not.toBeInTheDocument();
  });

  it('settings_form 带 form 道具时只渲染对应分区（无左导航轨）', () => {
    render(<SettingsForm form="environment" />);
    expect(screen.getByText('创建容器前必须人工审批（fail-closed）')).toBeInTheDocument();
    expect(screen.queryByText('router')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /系统配置/ })).not.toBeInTheDocument();
  });
});

describe('深看摘要条收敛（喂事件流 → 摘要文本正确）', () => {
  it('事件数组按类型计数收敛成一行摘要', () => {
    render(
      <SummaryBar
        label="演化动态"
        bindValue={[
          { type: 'signal_detected' },
          { type: 'signal_detected' },
          { type: 'gate_verdict' },
        ]}
      />,
    );
    expect(screen.getByText(/动态 3 条/)).toBeInTheDocument();
    expect(screen.getByText(/signal_detected 2/)).toBeInTheDocument();
    expect(screen.getByText(/gate_verdict 1/)).toBeInTheDocument();
  });

  it('空态回落文案不崩', () => {
    render(<SummaryBar label="演化动态" />);
    expect(screen.getByText('暂无动态')).toBeInTheDocument();
  });
});

describe('孤儿组件归位（注册表 ↔ ui_spec 引用）', () => {
  it('七个游离组件均在注册表白名单内', () => {
    for (const name of ORPHAN_COMPONENTS) {
      expect(isComponentRegistered(name)).toBe(true);
    }
  });

  it('布局树逐一对七个组件建立引用', () => {
    const types = new Set<string>();
    collectComponentTypes((fixtureSpec as unknown as UISpec).root as UINode, types);
    for (const name of ORPHAN_COMPONENTS) {
      expect(types.has(name)).toBe(true);
    }
  });
});

describe('缺视图可导航 / 可渲染', () => {
  it('管理台视图渲染返回条与内容', () => {
    render(<UIRenderer spec={fixtureSpec as unknown as UISpec} hub={new ChannelHub()} activeView="admin" />);
    expect(screen.getByText('管理台')).toBeInTheDocument();
  });

  it('架构视图渲染返回条与内容', () => {
    render(<UIRenderer spec={fixtureSpec as unknown as UISpec} hub={new ChannelHub()} activeView="architecture" />);
    expect(screen.getByText('架构')).toBeInTheDocument();
  });

  it('界面树视图渲染返回条与内容', () => {
    render(<UIRenderer spec={fixtureSpec as unknown as UISpec} hub={new ChannelHub()} activeView="edit_ui" />);
    expect(screen.getByText('界面树')).toBeInTheDocument();
  });
});

describe('未知 tab / 未知视图回落不崩', () => {
  it('未知视图不渲染任何视图内容且不崩', () => {
    expect(() =>
      render(<UIRenderer spec={fixtureSpec as unknown as UISpec} hub={new ChannelHub()} activeView={'zzz' as never} />),
    ).not.toThrow();
    expect(screen.queryByText('已回落基线布局')).not.toBeInTheDocument();
  });

  it('空 tab 容器不产生激活子级也不崩', () => {
    const spec: UISpec = {
      name: 'test.ui',
      version: 1,
      theme: { 'bg.base': '#09090b', 'text.base': '#e4e4e7', 'accent.approval': '#f59e0b' },
      root: {
        kind: 'container',
        type: 'app',
        children: [
          {
            kind: 'container',
            type: 'views',
            children: [
              {
                kind: 'container',
                type: 'tab',
                props: { view: 'main' },
                children: [],
              },
            ],
          },
        ],
      },
    };
    expect(() => render(<UIRenderer spec={spec} hub={new ChannelHub()} activeView="main" />)).not.toThrow();
  });
});
