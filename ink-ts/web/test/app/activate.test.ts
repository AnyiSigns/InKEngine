import { describe, it, expect, beforeEach, vi } from 'vitest';

import { activate, viewRegistrations } from '@/app/views/wave4activate';
import { createAppBackend } from '@/app/backend';

describe('activate (W4/W5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('activate 返回 settings sections', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    expect(sections.length).toBe(4);
    expect(sections.map((s) => s.key)).toEqual(['markets', 'tools', 'workspace', 'ui_editor']);
  });

  it('settings sections 按顺序排列', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const orders = sections.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('market section 只含 MCP 市场', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const marketSection = sections.find((s) => s.key === 'markets');
    expect(marketSection).toBeTruthy();
    const keys = marketSection!.items!.map((i) => i.key);
    expect(keys).toEqual(['mcp_market']);
  });

  it('tools section 包含工具面板', () => {
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

  it('ui_editor section 标注界面描述开发模式（ui_spec 命令面待 W2）', () => {
    const backend = createAppBackend({ backend: { available: false } as never });
    const { sections } = activate(backend);

    const uiSection = sections.find((s) => s.key === 'ui_editor');
    expect(uiSection).toBeTruthy();
    expect(uiSection!.items![0].key).toBe('ui_editor_host');
    expect(uiSection!.items![0].disabledReason).toContain('界面描述开发模式');
  });

  it('viewRegistrations 导出所有视图组件', () => {
    expect(viewRegistrations.mcp_market).toBeTruthy();
    expect(viewRegistrations.tools_panel).toBeTruthy();
    expect(viewRegistrations.workspace_auth).toBeTruthy();
    expect(viewRegistrations.ui_editor_host).toBeTruthy();
  });
});
