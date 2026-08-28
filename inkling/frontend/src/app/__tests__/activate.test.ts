import { describe, it, expect, beforeEach, vi } from 'vitest';

import { activate, viewRegistrations } from '../views/wave4activate';
import { createAppBackend } from '../backend';

describe('activate (W4/W5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('activate 返回 settings sections', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    expect(sections.length).toBe(5);
    expect(sections.map((s) => s.key)).toEqual(['markets', 'tools', 'os', 'workspace', 'ui_editor']);
  });

  it('settings sections 按顺序排列', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const orders = sections.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('market section 包含 MCP 市场 + 组件市场', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const marketSection = sections.find((s) => s.key === 'markets');
    expect(marketSection).toBeTruthy();
    const keys = marketSection!.items!.map((i) => i.key);
    expect(keys).toContain('mcp_market');
    expect(keys).toContain('component_market');
  });

  it('tools section 包含工具注册表', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const toolsSection = sections.find((s) => s.key === 'tools');
    expect(toolsSection).toBeTruthy();
    expect(toolsSection!.items![0].key).toBe('tools_panel');
  });

  it('os section 包含 OS 层视图', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const osSection = sections.find((s) => s.key === 'os');
    expect(osSection).toBeTruthy();
    expect(osSection!.items![0].key).toBe('os_view');
  });

  it('workspace section 包含授权 + 环境容器', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const wsSection = sections.find((s) => s.key === 'workspace');
    expect(wsSection).toBeTruthy();
    const keys = wsSection!.items!.map((i) => i.key);
    expect(keys).toContain('workspace_auth');
    expect(keys).toContain('environment_container');
  });

  it('environment_container 节带有 disabledReason（禁用态）', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const wsSection = sections.find((s) => s.key === 'workspace');
    const envItem = wsSection!.items!.find((i) => i.key === 'environment_container');
    expect(envItem!.disabledReason).toBeTruthy();
  });

  it('ui_editor section 包含界面树编辑器', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const uiSection = sections.find((s) => s.key === 'ui_editor');
    expect(uiSection).toBeTruthy();
    expect(uiSection!.items![0].key).toBe('ui_editor_host');
  });

  it('viewRegistrations 导出所有视图组件', () => {
    expect(viewRegistrations.mcp_market).toBeTruthy();
    expect(viewRegistrations.component_market).toBeTruthy();
    expect(viewRegistrations.tools_panel).toBeTruthy();
    expect(viewRegistrations.os_view).toBeTruthy();
    expect(viewRegistrations.workspace_auth).toBeTruthy();
    expect(viewRegistrations.environment_container).toBeTruthy();
    expect(viewRegistrations.ui_editor_host).toBeTruthy();
  });
});
