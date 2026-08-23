/**
 * 视图补全测试：管理台（三来源分组 + 停用/重置/卸载）、工具注册表
 * 分组、架构 DAG diff 高亮、界面树编辑器白名单拒绝与合法编辑。
 */

import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { registerBuiltinComponents } from '@/components';
import { AdminConsole } from '@/components/admin_console';
import { AdminTools } from '@/components/admin_tools';
import { ArchitectureView, diffGraphs } from '@/components/architecture_view';
import { UiSpecEditor } from '@/components/ui_spec_editor';
import { MemoryAppRegistryStore } from '@/shared/registry/appRegistry';
import type { AppRegistryEntry } from '@/shared/registry/appRegistry';
import type { GraphSnapshot, ToolsSnapshot } from '@/shared/session/inspectTypes';
import type { UISpec } from '@/renderer/uiSpecTypes';

beforeEach(() => {
  registerBuiltinComponents();
});

const FIXTURE_ENTRIES: AppRegistryEntry[] = [
  { id: 'b1', name: 'message_list', type: 'component', version: '1.4.0', source: 'baseline', status: 'active', changedAt: 1724131200000, description: '消息流' },
  { id: 'm1', name: 'web_search', type: 'mcp_server', version: '0.2.1', source: 'mcp', status: 'active', changedAt: 1724178600000, patchChainId: 'p-011', description: '搜索' },
  { id: 'a1', name: 'knowledge_row_refined', type: 'component', version: '0.5.0', source: 'ai', status: 'active', changedAt: 1724191800000, patchChainId: 'p-007', description: '知识行变体' },
];

describe('管理台：应用注册表三来源分组', () => {
  it('三来源分组 + 条目字段（名称/类型/版本/来源/状态/最近变化/补丁链）', () => {
    const store = new MemoryAppRegistryStore(FIXTURE_ENTRIES);
    render(<AdminConsole registryStore={store} />);
    expect(document.querySelector('[data-ui="registry_group_baseline"]')).not.toBeNull();
    expect(document.querySelector('[data-ui="registry_group_mcp"]')).not.toBeNull();
    expect(document.querySelector('[data-ui="registry_group_ai"]')).not.toBeNull();
    expect(screen.getByText(/补丁链 p-011/)).toBeInTheDocument();
    expect(screen.getAllByText('渲染组件').length).toBeGreaterThan(0);
  });

  it('出厂基线条目：可停用（切换状态）/ 重置（链清空）', async () => {
    const user = userEvent.setup();
    const store = new MemoryAppRegistryStore(FIXTURE_ENTRIES);
    render(<AdminConsole registryStore={store} />);
    await user.click(document.querySelector('[data-ui="registry_disable_b1"]') as HTMLElement);
    expect(store.list().find((e) => e.id === 'b1')?.status).toBe('disabled');
    await user.click(document.querySelector('[data-ui="registry_reset_b1"]') as HTMLElement);
    const reset = store.list().find((e) => e.id === 'b1');
    expect(reset?.patchChainId).toBeUndefined();
    expect(reset?.status).toBe('active');
  });

  it('MCP/AI 条目可卸载（基线条目不可卸载）', async () => {
    const user = userEvent.setup();
    const store = new MemoryAppRegistryStore(FIXTURE_ENTRIES);
    render(<AdminConsole registryStore={store} />);
    expect(document.querySelector('[data-ui="registry_uninstall_b1"]')).toBeNull();
    await user.click(document.querySelector('[data-ui="registry_uninstall_m1"]') as HTMLElement);
    expect(store.list().find((e) => e.id === 'm1')).toBeUndefined();
    await user.click(document.querySelector('[data-ui="registry_uninstall_a1"]') as HTMLElement);
    expect(store.list().find((e) => e.id === 'a1')).toBeUndefined();
    expect(store.list().map((e) => e.id)).toEqual(['b1']);
  });
});

describe('管理台：工具注册表分组（OS 控制/文件/网络/研究自指）+ description 全文', () => {
  const TOOLS: ToolsSnapshot = {
    version: 1,
    tools: [
      { name: 'launch_app', permission: 'review', endpoint: 'process_exec', description: '启动应用（会话焦点切换）' },
      { name: 'file_read', permission: 'allow', endpoint: 'file_ops', description: '读取工作区文件（路径白名单内）' },
      { name: 'fetch_web', permission: 'review', endpoint: 'http_fetch', description: '按 URL 抓取网页正文' },
      { name: 'inspect_knowledge', permission: 'allow', endpoint: 'process_exec', description: '知识集快照' },
      { name: 'propose_patch', permission: 'review', endpoint: 'process_exec', description: '提议补丁（自进化提案）' },
      { name: 'mcp_call', permission: 'deny', endpoint: 'mcp', description: 'MCP 调用' },
    ],
  };

  it('分组标签：OS 控制/文件/网络/研究自指/MCP 连接 + description 全文', () => {
    render(<AdminTools bindValue={TOOLS} />);
    expect(screen.getByText('OS 控制')).toBeInTheDocument();
    expect(screen.getByText('文件')).toBeInTheDocument();
    expect(screen.getByText('网络')).toBeInTheDocument();
    expect(screen.getByText('研究自指')).toBeInTheDocument();
    expect(screen.getByText('MCP 连接')).toBeInTheDocument();
    expect(screen.getByText('提议补丁（自进化提案）')).toBeInTheDocument();
  });

  it('权限档中文展示', () => {
    render(<AdminTools bindValue={TOOLS} />);
    expect(screen.getAllByText('待审批').length).toBeGreaterThan(0);
    expect(screen.getAllByText('自动放行').length).toBeGreaterThan(0);
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
  });
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
