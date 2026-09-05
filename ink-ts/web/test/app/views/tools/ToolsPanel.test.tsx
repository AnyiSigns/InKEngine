import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ToolsPanel } from '@/app/views/tools/ToolsPanel';
import { createAppBackend, type AppBackend } from '@/app/backend';
import type { ToolManifestEntry } from '@/shared/backend/backendAdapter';

const FACTORY_BASELINE = [
  'file_read', 'file_write', 'file_edit', 'grep', 'glob',
  'propose_patch', 'propose_domain_manifest', 'inspect_tools',
  'search_tools', 'request_tool',
];

const mockTools: ToolManifestEntry[] = [
  {
    name: 'collect_material',
    description: '收集研究素材的行为意图说明。',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '待取回 URL' } }, required: ['url'] },
    permissions: ['mcp:call:inkling_exec'],
    approval: 'review',
    endpoint: 'mcp',
    meta: { domain: 'research', auto_approvable: false },
    baseline: false,
  },
  {
    name: 'parse_material',
    description: '解析材料为结构化数据。',
    parameters: {},
    permissions: [],
    approval: 'allow',
    endpoint: 'mcp',
    meta: { domain: 'research', auto_approvable: true },
    baseline: false,
  },
  {
    name: 'ui_query',
    description: '查询界面元素。',
    parameters: {},
    permissions: ['mcp:call:os'],
    approval: 'allow',
    endpoint: 'mcp',
    meta: { domain: 'os', tier: 'main', sensor: 'ui' },
    baseline: false,
  },
  {
    name: 'fetch',
    description: '网络抓取。',
    parameters: {},
    permissions: ['network:connect:http'],
    approval: 'deny',
    endpoint: 'http',
    meta: { domain: 'network', tier: 'router', auto_approvable: false },
    baseline: false,
  },
  {
    name: 'shell_exec',
    description: '执行 Shell 命令。',
    parameters: {},
    permissions: ['exec:shell'],
    approval: 'deny',
    endpoint: 'process_exec',
    meta: { domain: 'os', tier: 'audit', deny_by_default: true },
    baseline: false,
  },
  {
    name: 'mcp_new_tool',
    description: 'MCP 挂载工具。',
    parameters: {},
    permissions: ['mcp:call:server_a'],
    approval: 'review',
    endpoint: 'mcp',
    endpoint_config: { server_id: 'server_a' },
    meta: { domain: 'research', mcp_server: 'server_a' },
    baseline: false,
  },
  ...FACTORY_BASELINE.map((name) => ({
    name,
    description: `${name} 工具`,
    parameters: {},
    permissions: [],
    approval: 'allow' as const,
    endpoint: 'file_ops',
    meta: { domain: 'file' },
    baseline: true,
  })),
];

const builtinMcpTool: ToolManifestEntry = {
  name: 'distill_knowledge',
  description: '蒸馏知识。',
  parameters: {},
  permissions: ['mcp:call:inkling_exec'],
  approval: 'review',
  endpoint: 'mcp',
  endpoint_config: { server_id: 'inkling_exec' },
  meta: { domain: 'research' },
  baseline: false,
};

function makeMockBackend(tools: ToolManifestEntry[] = mockTools): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  const baseline = tools.filter((t) => t.baseline).map((t) => t.name);
  vi.spyOn(backend, 'getToolsManifest').mockResolvedValue({ tools, baseline });
  vi.spyOn(backend, 'getMcpMarketStatus').mockResolvedValue({
    markets: [
      {
        id: 'market',
        name: '内置市场',
        source: '',
        builtin: true,
        servers: [
          {
            id: 'server_a',
            name: '服务 A',
            source: '',
            transport: 'stdio',
            url: null,
            command: null,
            args: [],
            credentials: { required: false, note: '' },
            risk: 'medium',
            risk_note: '',
            category: 'research',
            premounted: false,
          },
        ],
      },
    ],
    mounted: {},
  });
  return backend;
}

describe('ToolsPanel (工具管理)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染全部工具与常驻必带计数', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText(/个工具/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/常驻必带/).length).toBeGreaterThan(0);
  });

  it('常驻必带区展示已勾选工具', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('取消常驻').length).toBeGreaterThan(0);
    });
    const group = screen.getByText('常驻必带').closest('section');
    expect(group).toBeTruthy();
  });

  it('动态可用区 research 工具独立分组', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('动态可用')).toBeTruthy();
    });
    expect(screen.getByText('collect_material')).toBeTruthy();
  });

  it('MCP 工具带服务归属标签', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('mcp_new_tool').length).toBeGreaterThan(0);
    });
    const serverTag = screen.getAllByText('服务 A');
    expect(serverTag.length).toBeGreaterThan(0);
  });

  it('内置 MCP server 分组不带 MCP 前缀', async () => {
    const backend = makeMockBackend([...mockTools, builtinMcpTool]);
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('内置 · inkling_exec')).toBeTruthy();
    });
    expect(screen.queryByText('MCP · inkling_exec')).toBeNull();
  });

  it('搜索功能过滤工具', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('搜索工具（名称/中文标签）')).toBeTruthy();
    });

    const searchInput = screen.getByPlaceholderText('搜索工具（名称/中文标签）');
    fireEvent.change(searchInput!, { target: { value: 'fetch' } });

    await waitFor(() => {
      expect(screen.getByText('fetch')).toBeTruthy();
    });
  });

  it('工具详情抽屉显示行为手册', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByTitle('查看行为手册').length).toBeGreaterThan(0);
    });

    const detailBtns = screen.getAllByTitle('查看行为手册');
    fireEvent.click(detailBtns[0]!);

    await waitFor(() => {
      expect(screen.getByText('行为手册（description 原文）')).toBeTruthy();
    });
  });

  it('权限矩阵区展示与自动审批说明', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('权限矩阵')).toBeTruthy();
    });
    expect(screen.getByText(/预授权只读感知/)).toBeTruthy();
  });

  it('档位分段切换 → 调用 setTierOverrides', async () => {
    const backend = makeMockBackend();
    const setSpy = vi.spyOn(backend, 'setTierOverrides').mockResolvedValue({ ok: true });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('已拒绝').length).toBeGreaterThan(0);
    });

    const allowBtn = document.querySelector('[data-ui="tool_tier_collect_material_allow"]');
    expect(allowBtn).toBeTruthy();
    fireEvent.click(allowBtn!);

    await waitFor(() => {
      expect(setSpy).toHaveBeenCalled();
    });
    const payload = setSpy.mock.calls[0]![0] as Record<string, string>;
    expect(payload['collect_material']).toBe('allow');
  });

  it('deny 出厂档分段锁定不可覆盖', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('已拒绝').length).toBeGreaterThan(0);
    });

    const shellAllow = document.querySelector('[data-ui="tool_tier_shell_exec_allow"]') as HTMLButtonElement;
    expect(shellAllow).toBeTruthy();
    expect(shellAllow.disabled).toBe(true);
  });

  it('工具 tier 标签显示', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('main').length).toBeGreaterThan(0);
      expect(screen.getAllByText('router').length).toBeGreaterThan(0);
      expect(screen.getAllByText('audit').length).toBeGreaterThan(0);
    });
  });

  it('deny 档标记显示', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      const denyLabels = screen.getAllByText('已拒绝');
      expect(denyLabels.length).toBeGreaterThan(0);
    });
  });

  it('设为常驻 → 调用 setToolBaseline 并更新勾选态', async () => {
    const backend = makeMockBackend();
    const setSpy = vi.spyOn(backend, 'setToolBaseline').mockResolvedValue({
      ok: true,
      tools: [...FACTORY_BASELINE, 'collect_material'],
    });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('collect_material').length).toBeGreaterThan(0);
    });

    const pinButtons = screen.getAllByText('设为常驻');
    fireEvent.click(pinButtons[0]!);

    await waitFor(() => {
      expect(setSpy).toHaveBeenCalled();
    });
    expect(setSpy.mock.calls[0]![0]).toContain('collect_material');
  });

  it('取消常驻 → 调用 setToolBaseline 摘除', async () => {
    const backend = makeMockBackend();
    const setSpy = vi.spyOn(backend, 'setToolBaseline').mockResolvedValue({
      ok: true,
      tools: FACTORY_BASELINE.filter((n) => n !== 'file_read'),
    });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('取消常驻').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText('取消常驻')[0]!);

    await waitFor(() => {
      expect(setSpy).toHaveBeenCalled();
    });
    expect(setSpy.mock.calls[0]![0]).not.toContain('file_read');
  });

  it('检索机制工具显示强制常驻不可摘除', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('机制常驻').length).toBeGreaterThan(0);
    });
  });
});
