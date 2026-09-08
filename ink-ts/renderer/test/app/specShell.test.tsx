/**
 * 产品主壳 spec 直渲冒烟测试（K4A）：plugins/ui_features 装配生成物
 * （ui.generated.json）布局树 → UIRenderer → 各 canonical 组件
 * （file_tree/session_list/message_list/agent_input/... evolution/ledger 等）
 * 渲染与绑定载荷注入。
 *
 * 断言面：canonical 适配器全部挂到渲染器白名单并渲染对应产品组件；state.*
 * 绑定把 hub 会话数据注入 message_list；无宿主数据时空态不崩。
 */

import { render, screen } from '@testing-library/react';

import { ChannelHub } from '@/shared/session/channelHub';
import { registerBuiltinComponents } from '@/components';
import { registerPluginFaces } from '@/app/pluginFaces.generated';
import { UIRenderer } from '@/renderer/bootRenderer';
import type { UISpec } from '@/renderer/uiSpecTypes';

import uiLayout from '../../../plugins/ui.generated.json';

function makeHub(messages: unknown[] = []): ChannelHub {
  const hub = new ChannelHub();
  if (messages.length > 0) {
    hub.setState({ messages: messages as never });
  }
  return hub;
}

const baseProduct: Record<string, unknown> = {
  backend: null,
  sessions: [],
  branchTrees: {},
  authorized: false,
  workspaceRoot: null,
  models: undefined,
  agentModelId: null,
  hasTodo: false,
  todoPending: 0,
  settingsOpen: false,
  roundCount: 0,
  stepCount: 0,
};

describe('产品主壳 spec 直渲（ui_features 装配生成物 → canonical 组件）', () => {
  beforeEach(() => {
    registerBuiltinComponents();
    registerPluginFaces();
  });

  it('ui 装配生成物结构合法（可解析为渲染用 UISpec）', () => {
    const spec = uiLayout as unknown as UISpec;
    expect(spec.name).toBe('inkling.ui');
    expect(spec.version).toBe(3);
    expect(spec.root?.kind).toBe('container');
  });

  it('chat 视图：message_list 绑定注入消息 + 输入胶囊/左右栏渲染', () => {
    const hub = makeHub([
      { id: 'm1', kind: 'text', role: 'user', content: 'spec 直渲主壳', roundId: 'r1' },
    ]);
    const { container } = render(
      <UIRenderer
        spec={uiLayout as unknown as UISpec}
        hub={hub}
        activeView="chat"
        product={{ ...baseProduct, onSend: () => undefined }}
      />,
    );
    expect(screen.getByText('spec 直渲主壳')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="input_send"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="left_rail_toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="session_create"]')).not.toBeNull();
  });

  it('evolution 视图：演化流与机制监控 group 渲染（读取面空态可观测）', () => {
    const hub = makeHub();
    const { container } = render(
      <UIRenderer
        spec={uiLayout as unknown as UISpec}
        hub={hub}
        activeView="evolution"
        product={baseProduct}
      />,
    );
    expect(container.querySelector('[data-ui="group_机制监控"]')).not.toBeNull();
  });

  it('ledger/trajectory/todo 视图空态可渲染（无宿主不崩）', () => {
    const hub = makeHub();
    for (const view of ['ledger', 'trajectory', 'todo'] as const) {
      const { container } = render(
        <UIRenderer spec={uiLayout as unknown as UISpec} hub={hub} activeView={view} product={baseProduct} />,
      );
      expect(container.querySelector('[data-ui="mechanism_view"]')).toBeNull();
      expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
