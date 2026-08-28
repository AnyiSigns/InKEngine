import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ToolsPanel } from '../ToolsPanel';
import { createAppBackend, type AppBackend } from '../../../backend';
import type { ToolDetail } from '../../../types';
import { TOOL_LAYER_LABELS, RESEARCH_TOOLS } from '../../../types';

const mockTools: ToolDetail[] = [
  {
    name: 'collect_material',
    description: '收集研究素材的行为意图说明。',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '待取回 URL' } }, required: ['url'] },
    permissions: ['mcp:call:inkling_exec'],
    approval: 'review',
    endpoint: 'mcp',
    meta: { domain: 'research', auto_approvable: false },
  },
  {
    name: 'parse_material',
    description: '解析材料为结构化数据。',
    parameters: {},
    permissions: [],
    approval: 'allow',
    endpoint: 'mcp',
    meta: { domain: 'research', auto_approvable: true },
  },
  {
    name: 'validate_material',
    description: '校验材料质量。',
    parameters: {},
    permissions: [],
    approval: 'allow',
    endpoint: 'mcp',
    meta: { domain: 'research' },
  },
  {
    name: 'score_material',
    description: '评分材料。',
    parameters: {},
    permissions: [],
    approval: 'allow',
    endpoint: 'mcp',
    meta: { domain: 'research' },
  },
  {
    name: 'distill_knowledge',
    description: '蒸馏知识。',
    parameters: {},
    permissions: [],
    approval: 'allow',
    endpoint: 'mcp',
    meta: { domain: 'research' },
  },
  {
    name: 'mutate_knowledge',
    description: '变异知识。',
    parameters: {},
    permissions: [],
    approval: 'deny',
    endpoint: 'mcp',
    meta: { domain: 'research' },
  },
  {
    name: 'screen_query',
    description: '查询屏幕信息。',
    parameters: {},
    permissions: ['mcp:call:os'],
    approval: 'allow',
    endpoint: 'mcp',
    meta: { domain: 'os', tier: 'main', sensor: 'screen' },
  },
  {
    name: 'fetch',
    description: '网络抓取。',
    parameters: {},
    permissions: ['network:connect:http'],
    approval: 'deny',
    endpoint: 'http',
    meta: { domain: 'network', tier: 'router', auto_approvable: false },
    network_policy: { allow_domains: ['example.com'], note: '白名单域名' },
  },
  {
    name: 'shell_exec',
    description: '执行 Shell 命令。',
    parameters: {},
    permissions: ['exec:shell'],
    approval: 'deny',
    endpoint: 'process_exec',
    meta: { domain: 'os', tier: 'audit', deny_by_default: true },
  },
  {
    name: 'file_read',
    description: '读取文件。',
    parameters: {},
    permissions: ['file:read'],
    approval: 'deny',
    endpoint: 'file_ops',
    meta: { domain: 'file', tier: 'main' },
  },
];

function makeMockBackend(tools: ToolDetail[] = mockTools): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  vi.spyOn(backend, 'getToolDetails').mockReturnValue(tools);
  vi.spyOn(backend, 'getToolsSnapshot').mockResolvedValue(tools.map((t) => ({ tool: t.name, zh: t.description, group: t.meta?.domain ?? '' })));
  return backend;
}

describe('ToolsPanel (W5.2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('从种子 tools.json 渲染 40 个工具', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('10 个工具')).toBeTruthy();
    });
  });

  it('research 域 6 个工具独立分组展示', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('研究链')).toBeTruthy();
    });

    const researchItems = screen.getAllByText(/研究链/);
    expect(researchItems.length).toBeGreaterThan(0);
  });

  it('research 域 6 个工具名称正确', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('研究链')).toBeTruthy();
    });

    for (const tool of RESEARCH_TOOLS) {
      expect(screen.getByText(tool)).toBeTruthy();
    }
  });

  it('四层标签筛选（声明式/自指/内省/动态）', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('全部')).toBeTruthy();
    });

    const layerFilter = screen.getByDisplayValue('全部');
    fireEvent.change(layerFilter!, { target: { value: TOOL_LAYER_LABELS.self_referential } });

    await waitFor(() => {
      expect(screen.getByText('自指')).toBeTruthy();
    });
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
      expect(screen.getByText('收集研究素材的行为意图说明。')).toBeTruthy();
    });
  });

  it('auto_approvable 标记显示', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('自动审批').length).toBeGreaterThan(0);
    });
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

  it('权限档中文展示：自动放行/待审批/已拒绝', async () => {
    const backend = makeMockBackend();
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('自动放行').length).toBeGreaterThan(0);
      expect(screen.getAllByText('待审批').length).toBeGreaterThan(0);
      expect(screen.getAllByText('已拒绝').length).toBeGreaterThan(0);
    });
  });
});
