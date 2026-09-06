import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { McpMarket } from '@/app/views/markets/McpMarket';
import { createAppBackend, type AppBackend } from '@/app/backend';
import type { McpMarketData } from '@/shared/backend/backendAdapter';

function makeMockBackend(servers: McpMarketData['servers'] = []): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  vi.spyOn(backend, 'getMcpMarket').mockResolvedValue({
    source: '',
    premounted: false,
    mount_policy: {},
    servers,
  });
  vi.spyOn(backend, 'mountMcp').mockResolvedValue({ ok: true, server_id: 'mcp_1', status: 'mounted' });
  vi.spyOn(backend, 'unmountMcp').mockResolvedValue({ ok: true, server_id: 'mcp_1', status: 'unmounted' });
  return backend;
}

const sampleServers: McpMarketData['servers'] = [
  {
    id: 'mcp_1',
    name: '示例 HTTP Server',
    source: '社区公开 server（示例条目）',
    transport: 'http',
    url: 'https://api.example.com/mcp',
    command: null,
    args: [],
    credentials: { required: true, note: '需要 API Key 配置' },
    risk: 'high',
    risk_note: '访问外部 API。',
    category: 'research',
    mounted: false,
  },
  {
    id: 'mcp_2',
    name: '本地 stdio Server',
    source: '本地示例',
    transport: 'stdio',
    url: null,
    command: 'python',
    args: ['-m', 'mcp_server'],
    credentials: { required: false, note: '无需凭据' },
    risk: 'low',
    risk_note: '本地执行。',
    category: 'utility',
    mounted: false,
  },
];

describe('McpMarket (mcp.market 单源)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('从宿主状态渲染 MCP 服务器列表', async () => {
    const backend = makeMockBackend(sampleServers);
    render(<McpMarket backend={backend} />);

    expect(screen.getByText('MCP 市场')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('示例 HTTP Server')).toBeTruthy();
    });
    expect(screen.getByText('本地 stdio Server')).toBeTruthy();
  });

  it('空态显示「暂无市场服务」引导', async () => {
    const backend = makeMockBackend([]);
    render(<McpMarket backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText(/暂无市场服务/)).toBeTruthy();
    });
  });

  it('风险徽标渲染（高风险 label）', async () => {
    const backend = makeMockBackend(sampleServers);
    render(<McpMarket backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('高风险')).toBeTruthy();
    });
  });

  it('已挂载条目显示取消挂载按钮', async () => {
    const backend = makeMockBackend([{ ...sampleServers[0]!, mounted: true }]);
    render(<McpMarket backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('已挂载')).toBeTruthy();
      expect(screen.getByText('取消挂载')).toBeTruthy();
    });
  });

  it('stdio 挂载：打开 command 表单，确认后调 mountMcp 并刷新', async () => {
    const backend = makeMockBackend(sampleServers);
    render(<McpMarket backend={backend} />);

    await waitFor(() => {
      const mountBtns = screen.getAllByText('挂载');
      // 第二行 = stdio 条目
      fireEvent.click(mountBtns[1]!);
    });
    await waitFor(() => {
      expect(screen.getByText(/command（启动命令）/)).toBeTruthy();
    });
    const commandInput = document.querySelector('[data-ui="mcp_mount_command"]') as HTMLInputElement;
    expect(commandInput.value).toBe('python');
    fireEvent.click(screen.getByText('确认挂载'));
    await waitFor(() => {
      expect(backend.mountMcp).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'mcp_2', transport: 'stdio', command: 'python', args: ['-m', 'mcp_server'] }),
      );
    });
  });

  it('取消挂载调用 unmountMcp', async () => {
    const backend = makeMockBackend([{ ...sampleServers[0]!, mounted: true }]);
    render(<McpMarket backend={backend} />);

    await waitFor(() => {
      fireEvent.click(screen.getByText('取消挂载'));
    });
    await waitFor(() => {
      expect(backend.unmountMcp).toHaveBeenCalledWith('mcp_1');
    });
  });

  it('挂载失败显示 notice（不假成功）', async () => {
    const backend = makeMockBackend(sampleServers);
    vi.spyOn(backend, 'mountMcp').mockResolvedValue({ ok: false, server_id: 'mcp_2', status: 'mount_failed', error: '连接失败' });
    render(<McpMarket backend={backend} />);

    await waitFor(() => {
      fireEvent.click(screen.getAllByText('挂载')[1]!);
    });
    fireEvent.click(screen.getByText('确认挂载'));
    await waitFor(() => {
      expect(screen.getByText(/连接失败/)).toBeTruthy();
    });
  });
});
