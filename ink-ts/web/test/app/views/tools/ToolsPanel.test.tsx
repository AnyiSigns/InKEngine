import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ToolsPanel } from '@/app/views/tools/ToolsPanel';
import { createAppBackend, type AppBackend } from '@/app/backend';
import type { ToolFullView } from '@/shared/backend/backendAdapter';

function makeMockBackend(tools: ToolFullView['tools'] = []): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  vi.spyOn(backend, 'getToolsManifest').mockResolvedValue({ uses_vectors: true, tools });
  vi.spyOn(backend, 'getToolBaseline').mockResolvedValue([]);
  vi.spyOn(backend, 'getCapability').mockResolvedValue({
    autoApproveTools: [],
    autoApproveAllReview: false,
    tierOverrides: {},
    maxToolRounds: 8,
  });
  return backend;
}

function row(name: string, overrides: Partial<ToolFullView['tools'][number]> = {}): ToolFullView['tools'][number] {
  return { name, uses_vectors: true, vector: true, baseline: false, approved: false, enabled: true, ...overrides };
}

const SAMPLE = [
  row('file_read', { baseline: true, approved: true }),
  row('shell_exec'),
  row('collect_material'),
  row('search_tools', { baseline: true }),
];

describe('ToolsPanel (工具管理，tools.full 数据源)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染全部工具与常驻必带计数', async () => {
    const backend = makeMockBackend(SAMPLE);
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('shell_exec').length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/常驻必带 2/)).toBeTruthy();
    expect(screen.getAllByText(/tools.full/).length).toBeGreaterThan(0);
  });

  it('常驻必带区展示已勾选工具（可摘除）', async () => {
    const backend = makeMockBackend(SAMPLE);
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('取消常驻').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('file_read').length).toBeGreaterThan(0);
  });

  it('检索机制工具显示强制常驻不可摘除', async () => {
    const backend = makeMockBackend(SAMPLE);
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('机制常驻').length).toBeGreaterThan(0);
    });
  });

  it('动态区展示非常驻工具并可设为常驻', async () => {
    const backend = makeMockBackend(SAMPLE);
    const setSpy = vi.spyOn(backend, 'setToolBaseline').mockResolvedValue({
      ok: true,
      tools: ['file_read', 'search_tools', 'collect_material'],
    });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('collect_material').length).toBeGreaterThan(0);
    });
    const addBtn = document.querySelector('[data-ui="baseline_add_collect_material"]') as HTMLElement;
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);
    await waitFor(() => {
      expect(setSpy).toHaveBeenCalled();
    });
    expect(setSpy.mock.calls[0]![0]).toContain('collect_material');
  });

  it('常驻工具摘除 → 调 setToolBaseline', async () => {
    const backend = makeMockBackend(SAMPLE);
    const setSpy = vi.spyOn(backend, 'setToolBaseline').mockResolvedValue({ ok: true, tools: ['search_tools'] });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('file_read').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByText('取消常驻')[0]!);
    await waitFor(() => {
      expect(setSpy).toHaveBeenCalled();
    });
    expect(setSpy.mock.calls[0]![0]).not.toContain('file_read');
  });

  it('常驻设置白名单校验失败给 notice（不假成功）', async () => {
    const backend = makeMockBackend(SAMPLE);
    vi.spyOn(backend, 'setToolBaseline').mockResolvedValue({ ok: false, error: '未注册工具名: nope' });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      fireEvent.click(screen.getAllByText('设为常驻')[0]!);
    });
    await waitFor(() => {
      expect(screen.getByText(/未注册工具名/)).toBeTruthy();
    });
  });

  it('档位分段切换 → 调 setTierOverrides（allow/review）', async () => {
    const backend = makeMockBackend(SAMPLE);
    const setSpy = vi.spyOn(backend, 'setTierOverrides').mockResolvedValue({ ok: true });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('shell_exec').length).toBeGreaterThan(0);
    });
    const allowBtn = document.querySelector('[data-ui="tool_tier_shell_exec_allow"]');
    expect(allowBtn).toBeTruthy();
    fireEvent.click(allowBtn!);
    await waitFor(() => {
      expect(setSpy).toHaveBeenCalled();
    });
    const payload = setSpy.mock.calls[0]![0] as Record<string, string>;
    expect(payload['shell_exec']).toBe('allow');
  });

  it('自动审批勾选 → 调 setAutoApprove 并回显', async () => {
    const backend = makeMockBackend(SAMPLE);
    const setSpy = vi.spyOn(backend, 'setAutoApprove').mockResolvedValue({ ok: true });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      const autoCheck = document.querySelector('[data-ui="auto_approve_row_shell_exec"] input') as HTMLInputElement;
      fireEvent.click(autoCheck);
    });
    await waitFor(() => {
      expect(setSpy).toHaveBeenCalled();
    });
    expect(setSpy.mock.calls[0]![0]).toContain('shell_exec');
  });

  it('回合上限保存 → 调 setMaxToolRounds', async () => {
    const backend = makeMockBackend(SAMPLE);
    const setSpy = vi.spyOn(backend, 'setMaxToolRounds').mockResolvedValue({ ok: true });
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      const input = document.querySelector('[data-ui="max_tool_rounds"]') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '12' } });
      fireEvent.blur(input);
    });
    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith(12);
    });
  });

  it('工具详情浮层展示消费旗标', async () => {
    const backend = makeMockBackend(SAMPLE);
    render(<ToolsPanel backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByTitle('查看行为手册').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByTitle('查看行为手册')[0]!);
    await waitFor(() => {
      expect(document.querySelector('[data-ui="tool_detail_overlay"]')).toBeTruthy();
    });
  });
});
