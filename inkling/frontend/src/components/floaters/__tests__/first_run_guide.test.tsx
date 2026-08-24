/**
 * 首启引导测试：三点说明渲染、关闭经宿主落标记、无宿主直接关闭。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FirstRunGuide } from '../first_run_guide';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';

function backendWith(dismiss: ReturnType<typeof vi.fn>): BackendAdapter {
  return {
    available: true,
    firstRunDismiss: dismiss,
  } as unknown as BackendAdapter;
}

describe('first_run_guide', () => {
  it('渲染三点说明（数据目录/模型配置/权限默认档）', () => {
    render(<FirstRunGuide backend={null} onDismissed={() => undefined} />);
    expect(screen.getByText('数据全部在本地')).toBeTruthy();
    expect(screen.getByText('模型由你配置')).toBeTruthy();
    expect(screen.getByText('权限默认克制')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '首次启动引导' })).toBeTruthy();
  });

  it('开始使用：宿主落标记后关闭', async () => {
    const dismiss = vi.fn(async () => ({ dismissed: true }));
    const onDismissed = vi.fn();
    render(<FirstRunGuide backend={backendWith(dismiss)} onDismissed={onDismissed} />);
    fireEvent.click(screen.getByRole('button', { name: /开始使用/ }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onDismissed).toHaveBeenCalledTimes(1));
  });

  it('宿主不可用：直接关闭（无宿主回落形态）', () => {
    const onDismissed = vi.fn();
    render(<FirstRunGuide backend={null} onDismissed={onDismissed} />);
    fireEvent.click(screen.getByRole('button', { name: /开始使用/ }));
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });
});
