/**
 * 视图补全测试：架构 DAG diff 高亮、界面树编辑器白名单拒绝与合法编辑。
 */

import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { registerBuiltinComponents } from '@/components';
import { ArchitectureView, diffGraphs } from '@/components/architecture_view';
import { UiSpecEditor } from '@/components/ui_spec_editor';
import type { GraphSnapshot } from '@/shared/session/inspectTypes';
import type { UISpec } from '@/renderer/uiSpecTypes';

beforeEach(() => {
  registerBuiltinComponents();
});

describe('架构视图：DAG 读 + 视觉 diff 高亮', () => {
  const current: GraphSnapshot = {
    version: 3,
    nodes: [
      { id: 'entry', type: 'entry', label: '入口' },
      { id: 'orchestrate', type: 'research_orchestrator', label: '研究编排（强化）' },
      { id: 'gate', type: 'gate', label: '闸门判定' },
    ],
    edges: [],
    patchChain: [],
  };
  const baseline: GraphSnapshot = {
    version: 2,
    nodes: [
      { id: 'entry', type: 'entry', label: '入口' },
      { id: 'orchestrate', type: 'research_orchestrator', label: '研究编排' },
      { id: 'collect', type: 'tool', label: '采集材料' },
    ],
    edges: [],
    patchChain: [],
  };

  it('diff 计算：变更/新增/移除三类标记', () => {
    const diff = diffGraphs(current, baseline);
    expect([...diff.changed]).toContain('orchestrate');
    expect([...diff.added]).toContain('gate');
    expect([...diff.removed]).toContain('collect');
  });

  it('渲染高亮标记（data-diff + 计数）', () => {
    render(<ArchitectureView bindValue={current} baseline={baseline} />);
    expect(document.querySelector('[data-ui="arch_node_orchestrate"]')?.getAttribute('data-diff')).toBe('changed');
    expect(document.querySelector('[data-ui="arch_node_gate"]')?.getAttribute('data-diff')).toBe('added');
    expect(document.querySelector('[data-ui="arch_node_collect"]')).toBeNull();
    expect(screen.getByText('新增 1')).toBeInTheDocument();
    expect(screen.getByText('移除 1')).toBeInTheDocument();
    expect(screen.getByText('变更 1')).toBeInTheDocument();
  });

  it('空快照空态', () => {
    render(<ArchitectureView bindValue={null} />);
    expect(screen.getByText(/暂无回合图/)).toBeInTheDocument();
  });
});

const EDIT_SPEC: UISpec = {
  name: 'inkling.ui',
  version: 1,
  root: {
    kind: 'container',
    type: 'column',
    children: [
      { kind: 'component', type: 'message_list', bind: { channel: 'state.messages', path: '' } },
      { kind: 'component', type: 'agent_input' },
    ],
  },
};

describe('界面树编辑器：白名单约束与合法编辑', () => {
  it('组件引用限白名单：未注册组件拒绝并提示、草稿不变', async () => {
    const user = userEvent.setup();
    render(<UiSpecEditor uiSpec={EDIT_SPEC} />);
    await user.click(document.querySelector('[data-ui="editor_row_root.0"]') as HTMLElement);
    const typeInput = document.querySelector('[data-ui="editor_type"]') as HTMLInputElement;
    await user.clear(typeInput);
    await user.type(typeInput, 'dyn_widget');
    expect(screen.getByText(/组件未注册（组件白名单拒绝），未应用：dyn_widget/)).toBeInTheDocument();
    // 恢复合法类型：已注册组件放行
    await user.clear(typeInput);
    await user.type(typeInput, 'agent_input');
    expect(screen.queryByText(/未注册/)).not.toBeInTheDocument();
  });

  it('bind 通道白名单：未放行通道拒绝并提示', async () => {
    const user = userEvent.setup();
    render(<UiSpecEditor uiSpec={EDIT_SPEC} />);
    await user.click(document.querySelector('[data-ui="editor_row_root.0"]') as HTMLElement);
    const bindChannel = document.querySelector('[data-ui="editor_bind_channel"]') as HTMLInputElement;
    await user.clear(bindChannel);
    await user.type(bindChannel, 'state.unknown_channel');
    expect(screen.getByText(/绑定通道未放行（通道\/路径白名单拒绝），未应用/)).toBeInTheDocument();
    await user.clear(bindChannel);
    await user.type(bindChannel, 'state.pendingReview');
    expect(screen.queryByText(/绑定通道未放行/)).not.toBeInTheDocument();
  });

  it('props 非合法 JSON 拒绝，合法对象落草稿', async () => {
    const user = userEvent.setup();
    render(<UiSpecEditor uiSpec={EDIT_SPEC} />);
    await user.click(document.querySelector('[data-ui="editor_row_root.1"]') as HTMLElement);
    const propsInput = document.querySelector('[data-ui="editor_props"]') as HTMLInputElement;
    fireEvent.change(propsInput, { target: { value: '{bad json' } });
    expect(screen.getByText('props 非合法 JSON 对象，未应用')).toBeInTheDocument();
    fireEvent.change(propsInput, { target: { value: '{}' } });
    expect(screen.queryByText('props 非合法 JSON 对象')).not.toBeInTheDocument();
  });

  it('面板增删/移动：上移/添加子组件/删除', async () => {
    const user = userEvent.setup();
    render(<UiSpecEditor uiSpec={EDIT_SPEC} />);
    // 选中第二个子项（agent_input）并上移 → 根序反转
    await user.click(document.querySelector('[data-ui="editor_row_root.1"]') as HTMLElement);
    await user.click(document.querySelector('[data-ui="editor_move_up"]') as HTMLElement);
    expect(document.querySelector('[data-ui="editor_row_root.0"]')?.textContent).toContain('agent_input');
    expect(document.querySelector('[data-ui="editor_row_root.1"]')?.textContent).toContain('bind:state.messages');
    // 根容器添加子组件（新子项自动选中）
    await user.click(document.querySelector('[data-ui="editor_row_root"]') as HTMLElement);
    await user.click(document.querySelector('[data-ui="editor_add_component"]') as HTMLElement);
    expect(document.querySelector('[data-ui="editor_row_root.2"]')).not.toBeNull();
    // 删除新加子项
    await user.click(document.querySelector('[data-ui="editor_remove"]') as HTMLElement);
    expect(document.querySelector('[data-ui="editor_row_root.2"]')).toBeNull();
  });

  it('应用入口：校验通过后回调宿主（onApplyUiSpec）', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<UiSpecEditor uiSpec={EDIT_SPEC} onApplyUiSpec={onApply} />);
    await user.click(document.querySelector('[data-ui="editor_apply"]') as HTMLElement);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ name: 'inkling.ui' }));
  });
});
