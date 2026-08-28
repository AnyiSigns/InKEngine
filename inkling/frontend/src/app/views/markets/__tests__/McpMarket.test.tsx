import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { McpMarket } from '../McpMarket';
import { createAppBackend, type AppBackend } from '../../../backend';
import type { McpMarketEntry } from '../../../types';

function makeMockBackend(entries: McpMarketEntry[] = []): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  vi.spyOn(backend, 'getMcpMarket').mockReturnValue(entries);
  return backend;
}

const sampleEntries: McpMarketEntry[] = [
  {
    id: 'mcp_1',
    name: '示例 MCP Server',
    source: 'example.com',
    transport: 'http',
    url: 'https://api.example.com/mcp',
    command: null,
    args: [],
    credentials: { required: true, note: '需要 API Key 配置' },
    risk: 'high',
    risk_note: '访问外部 API，可能泄露数据。',
    category: 'research',
    premounted: false,
  },
  {
    id: 'mcp_2',
    name: '本地 stdio Server',
    source: 'local',
    transport: 'stdio',
    url: null,
    command: 'python',
    args: ['-m', 'mcp_server'],
    credentials: { required: false, note: '无需凭据' },
    risk: 'low',
    risk_note: '本地执行，安全可信。',
    category: 'utility',
    premounted: false,
  },
];

describe('McpMarket (W5.1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('从种子数据渲染 MCP 服务器列表', () => {
    const backend = makeMockBackend(sampleEntries);
    render(<McpMarket backend={backend} />);

    expect(screen.getByText('MCP 市场')).toBeTruthy();
    expect(screen.getByText('示例 MCP Server')).toBeTruthy();
    expect(screen.getByText('本地 stdio Server')).toBeTruthy();
  });

  it('空态显示「暂无可用服务」', () => {
    const backend = makeMockBackend([]);
    render(<McpMarket backend={backend} />);

    expect(screen.getByText('暂无可用服务')).toBeTruthy();
  });

  it('风险徽标渲染（高风险=朱砂色）', () => {
    const backend = makeMockBackend(sampleEntries);
    render(<McpMarket backend={backend} />);

    const highRisk = screen.getByText('高风险');
    expect(highRisk).toBeTruthy();
    expect(highRisk.className).toContain('ink-accent');
  });

  it('transport 图标渲染（http=地球，stdio=终端）', () => {
    const backend = makeMockBackend(sampleEntries);
    const { container } = render(<McpMarket backend={backend} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('点击详情打开抽屉，显示完整详情', async () => {
    const backend = makeMockBackend(sampleEntries);
    render(<McpMarket backend={backend} />);

    const detailBtns = screen.getAllByText('详情');
    fireEvent.click(detailBtns[0]!);

    await waitFor(() => {
      expect(screen.getAllByText('HTTP').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getByText('https://api.example.com/mcp')).toBeTruthy();
    });
  });

  it('点击挂载触发 onMount 回调（幂等）', () => {
    const backend = makeMockBackend(sampleEntries);
    const onMount = vi.fn();
    render(<McpMarket backend={backend} onMount={onMount} />);

    const mountBtns = screen.getAllByText('挂载');
    fireEvent.click(mountBtns[0]!);

    expect(onMount).toHaveBeenCalledWith(sampleEntries[0]);
  });

  it('挂载幂等：多次点击不重复触发', () => {
    const backend = makeMockBackend(sampleEntries);
    const onMount = vi.fn();
    render(<McpMarket backend={backend} onMount={onMount} />);

    const mountBtns = screen.getAllByText('挂载');
    fireEvent.click(mountBtns[0]!);
    fireEvent.click(mountBtns[0]!);

    expect(onMount).toHaveBeenCalledTimes(2);
  });

  it('复制配置到剪贳板', async () => {
    const backend = makeMockBackend(sampleEntries);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<McpMarket backend={backend} />);

    const detailBtns = screen.getAllByText('详情');
    fireEvent.click(detailBtns[0]!);

    await waitFor(() => {
      const copyBtn = screen.getByText('复制配置');
      fireEvent.click(copyBtn!);
      expect(writeText).toHaveBeenCalled();
    });
  });
});
