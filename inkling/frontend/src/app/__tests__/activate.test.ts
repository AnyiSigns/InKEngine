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
    expect(sections.map((s) => s.key)).toEqual(['markets', 'components', 'tools', 'workspace', 'ui_editor']);
  });

  it('settings sections 按顺序排列', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const orders = sections.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('market section 只含 MCP 市场（组件已分离）', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const marketSection = sections.find((s) => s.key === 'markets');
    expect(marketSection).toBeTruthy();
    const keys = marketSection!.items!.map((i) => i.key);
    expect(keys).toEqual(['mcp_market']);
    expect(keys).not.toContain('component_market');
  });

  it('components section 展示已注册组件清单', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const componentsSection = sections.find((s) => s.key === 'components');
    expect(componentsSection).toBeTruthy();
    expect(componentsSection!.items![0].key).toBe('component_registry');
  });

  it('tools section 包含工具注册表', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const toolsSection = sections.find((s) => s.key === 'tools');
    expect(toolsSection).toBeTruthy();
    expect(toolsSection!.items![0].key).toBe('tools_panel');
  });

  it('workspace section 包含授权目录', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const wsSection = sections.find((s) => s.key === 'workspace');
    expect(wsSection).toBeTruthy();
    const keys = wsSection!.items!.map((i) => i.key);
    expect(keys).toContain('workspace_auth');
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
    expect(viewRegistrations.component_registry).toBeTruthy();
    expect(viewRegistrations.tools_panel).toBeTruthy();
    expect(viewRegistrations.workspace_auth).toBeTruthy();
    expect(viewRegistrations.ui_editor_host).toBeTruthy();
  });
});
