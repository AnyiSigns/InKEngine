/**
 * plugins 设置面板真面测试：manifest 派生目录 + 常驻必带（capability.baseline）+
 * 界面组件启停（ui_components）+ 服务启停（mcp.status/enable/disable，B5）+ 回合上限。
 * 注入 mock AppBackend（getToolsManifest/getToolBaseline/setToolBaseline/
 * getMaxToolRounds/setMaxToolRounds/getUiComponentsState/setUiComponentsDisabled/
 * getMcpPlugins/mcpPluginEnable/mcpPluginDisable），断言动作落在正确命令面。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import type { AppBackend } from '@app/backend';
import { derivePluginsCatalog } from '@app/pluginsCatalog';
import { PluginsPanel } from './PluginsPanel';

function makeMockBackend(): AppBackend {
  return {
    available: true,
    getToolsManifest: vi.fn(async () => ({
      uses_vectors: true,
      tools: [
        { name: 'search_tools', uses_vectors: true, vector: true, baseline: true, approved: true, enabled: true },
        { name: 'grep', uses_vectors: true, vector: true, baseline: false, approved: false, enabled: true },
        { name: 'file_write', uses_vectors: true, vector: false, baseline: false, approved: false, enabled: true },
      ],
    })),
    getToolBaseline: vi.fn(async () => ['search_tools']),
    setToolBaseline: vi.fn(async (tools: string[]) => ({ ok: true, tools })),
    getMaxToolRounds: vi.fn(async () => 12),
    setMaxToolRounds: vi.fn(async () => ({ ok: true })),
    getUiComponentsState: vi.fn(async () => ({
      factory: ['agent_input', 'message_list', 'evolution_feed'],
      protected: ['agent_input', 'message_list'],
      disabled: ['message_list'],
      active: ['agent_input', 'evolution_feed'],
    })),
    setUiComponentsDisabled: vi.fn(async (disabled: string[]) => ({ ok: true, disabled })),
    getMcpPlugins: vi.fn(async () => ({
      source: '',
      servers: [
        {
          id: 'market.browser_use',
          name: 'Browser Use',
          source: 'seed',
          transport: 'stdio',
          url: null,
          command: 'npx',
          args: ['-y', '@browser-use/mcp'],
          risk: 'high',
          enabled: true,
          connected: true,
          tool_count: 3,
          error: null,
        },
        {
          id: 'market.web_fetch',
          name: 'Web Fetch',
          source: 'seed',
          transport: 'http',
          url: 'https://r.jina.ai',
          command: null,
          args: [],
          enabled: false,
          connected: false,
          tool_count: 0,
          error: null,
        },
      ],
    })),
    mcpPluginEnable: vi.fn(async (id: string) => ({ ok: true, server_id: id, transport: 'stdio', enabled: true, connected: true, tool_count: 2, tools: ['echo_text'] })),
    mcpPluginDisable: vi.fn(async (id: string) => ({ ok: true, server_id: id, transport: 'stdio', enabled: false, connected: false, tool_count: 0 })),
  } as unknown as AppBackend;
}

describe('PluginsPanel（插件设置段）', () => {
  it('渲染目录概览 + 常驻必带组 + 服务组', async () => {
    const backend = makeMockBackend();
    const catalog = derivePluginsCatalog();
    const { container } = render(<PluginsPanel backend={backend} catalog={catalog} />);
    expect(container.querySelector('[data-ui="plugins_panel"]')).not.toBeNull();
    await waitFor(() => {
      expect(container.querySelector('[data-tool="search_tools"]')).not.toBeNull();
      expect(container.querySelector('[data-mcp-server="market.browser_use"]')).not.toBeNull();
    });
  });

  it('动态工具设常驻 → setToolBaseline（白名单校验走命令面）', async () => {
    const backend = makeMockBackend();
    const { container } = render(<PluginsPanel backend={backend} catalog={derivePluginsCatalog()} />);
    await waitFor(() => {
      expect(container.querySelector('[data-ui="baseline_add_grep"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-ui="baseline_add_grep"]') as HTMLElement);
    await waitFor(() => {
      expect(backend.setToolBaseline).toHaveBeenCalledWith(expect.arrayContaining(['grep']));
    });
  });

  it('界面组件停用切换 → setUiComponentsDisabled（整集替换）', async () => {
    const backend = makeMockBackend();
    const { container } = render(<PluginsPanel backend={backend} catalog={derivePluginsCatalog()} />);
    await waitFor(() => {
      expect(container.querySelector('[data-ui="ui_component_evolution_feed"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-ui="ui_component_toggle_evolution_feed"]') as HTMLElement);
    await waitFor(() => {
      expect(backend.setUiComponentsDisabled).toHaveBeenCalled();
    });
  });

  it('禁停集组件展示禁停徽标且无启停钮', async () => {
    const backend = makeMockBackend();
    const { container } = render(<PluginsPanel backend={backend} catalog={derivePluginsCatalog()} />);
    await waitFor(() => {
      expect(container.querySelector('[data-ui="ui_component_protected_agent_input"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-ui="ui_component_toggle_agent_input"]')).toBeNull();
  });

  it('服务停用 → mcpPluginDisable（已启用行出停用钮）', async () => {
    const backend = makeMockBackend();
    const { container } = render(<PluginsPanel backend={backend} catalog={derivePluginsCatalog()} />);
    await waitFor(() => {
      expect(container.querySelector('[data-ui="service_disable_market.browser_use"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-ui="service_disable_market.browser_use"]') as HTMLElement);
    await waitFor(() => {
      expect(backend.mcpPluginDisable).toHaveBeenCalledWith('market.browser_use');
    });
  });

  it('服务启用 → mcpPluginEnable（未启用行出启用钮）', async () => {
    const backend = makeMockBackend();
    const { container } = render(<PluginsPanel backend={backend} catalog={derivePluginsCatalog()} />);
    await waitFor(() => {
      expect(container.querySelector('[data-ui="service_enable_market.web_fetch"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-ui="service_enable_market.web_fetch"]') as HTMLElement);
    await waitFor(() => {
      expect(backend.mcpPluginEnable).toHaveBeenCalledWith('market.web_fetch');
    });
  });

  it('装配只读：命令/端点徽标列出（无动作按钮）', async () => {
    const backend = makeMockBackend();
    render(<PluginsPanel backend={backend} catalog={derivePluginsCatalog()} />);
    expect(screen.getByText(/rounds\.send/)).toBeInTheDocument();
  });
});
