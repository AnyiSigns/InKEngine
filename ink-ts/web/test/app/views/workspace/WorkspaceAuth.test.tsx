import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { WorkspaceAuth } from '@/app/views/workspace/WorkspaceAuth';
import { createAppBackend, type AppBackend } from '@/app/backend';

function makeMockBackend(state: { authorized: boolean; root: string | null } = { authorized: false, root: null }): AppBackend {
  const backend = createAppBackend({ backend: { available: true } as never });
  vi.spyOn(backend, 'getAuthorizationState').mockResolvedValue(state);
  vi.spyOn(backend, 'authorizeWorkspace').mockResolvedValue({ authorized: true, root: '/workspace/authorized' });
  vi.spyOn(backend, 'revokeWorkspace').mockResolvedValue({ authorized: false });
  vi.spyOn(backend, 'openPath').mockImplementation(() => {});
  return backend;
}

describe('WorkspaceAuth (W5.5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染工作区授权标题', () => {
    const backend = makeMockBackend();
    render(<WorkspaceAuth backend={backend} />);

    expect(screen.getByText('工作区授权')).toBeTruthy();
  });

  it('初始化加载授权状态', async () => {
    const backend = makeMockBackend({ authorized: true, root: '/workspace/test' });
    render(<WorkspaceAuth backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('已授权')).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText('/workspace/test')).toBeTruthy();
    });
  });

  it('未授权状态显示撤销按钮禁用', async () => {
    const backend = makeMockBackend({ authorized: false, root: null });
    render(<WorkspaceAuth backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('未授权')).toBeTruthy();
    });

    const revokeBtn = screen.getByText('撤销授权');
    expect(revokeBtn).toBeDisabled();
  });

  it('添加授权目录按钮存在且无手动路径输入框（走原生选择器）', () => {
    const backend = makeMockBackend();
    render(<WorkspaceAuth backend={backend} />);

    expect(screen.getByText('添加授权目录')).toBeTruthy();
    expect(screen.queryByPlaceholderText('请输入目录路径')).toBeFalsy();
    expect(screen.queryByText('取消')).toBeFalsy();
  });

  it('撤销授权 e2e：点击撤销 → 状态更新为未授权', async () => {
    const backend = makeMockBackend({ authorized: true, root: '/workspace/test' });
    render(<WorkspaceAuth backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('已授权')).toBeTruthy();
    });

    const revokeBtns = screen.getAllByText('撤销授权');
    fireEvent.click(revokeBtns[0]!);

    await waitFor(() => {
      expect(backend.revokeWorkspace).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByText('未授权')).toBeTruthy();
    });
  });

  it('挂载管理列表渲染', () => {
    const backend = makeMockBackend();
    render(<WorkspaceAuth backend={backend} />);

    expect(screen.getByText('挂载管理列表')).toBeTruthy();
  });
});
