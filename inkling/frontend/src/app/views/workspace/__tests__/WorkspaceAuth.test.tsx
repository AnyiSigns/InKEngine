import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { WorkspaceAuth } from '../WorkspaceAuth';
import { createAppBackend, type AppBackend } from '../../../backend';

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

  it('点击「添加授权目录」打开弹窗', async () => {
    const backend = makeMockBackend();
    render(<WorkspaceAuth backend={backend} />);

    const addBtns = screen.getAllByText('添加授权目录');
    fireEvent.click(addBtns[0]!);

    expect(screen.getByPlaceholderText('请输入目录路径')).toBeTruthy();
  });

  it('授权 e2e：输入路径 → 授权 → 状态更新', async () => {
    const backend = makeMockBackend();
    render(<WorkspaceAuth backend={backend} />);

    const addBtns = screen.getAllByText('添加授权目录');
    fireEvent.click(addBtns[0]!);

    const input = screen.getByPlaceholderText('请输入目录路径');
    fireEvent.change(input!, { target: { value: '/my/workspace' } });

    const confirmBtns = screen.getAllByText('授权');
    fireEvent.click(confirmBtns[0]!);

    await waitFor(() => {
      expect(backend.authorizeWorkspace).toHaveBeenCalledWith('/my/workspace');
    });

    await waitFor(() => {
      expect(screen.getByText('已授权')).toBeTruthy();
    });
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

  it('弹窗取消按钮关闭弹窗', async () => {
    const backend = makeMockBackend();
    render(<WorkspaceAuth backend={backend} />);

    fireEvent.click(screen.getByText('添加授权目录')!);
    const cancelBtn = screen.getByText('取消');
    fireEvent.click(cancelBtn!);

    expect(screen.queryByText('请输入目录路径')).toBeFalsy();
  });
});
