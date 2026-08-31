/**
 * 待办清单页测试：条目渲染/状态 chip/证据/空态/宿主不可用。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import type { BackendAdapter, TodoList } from '@/shared/backend/backendAdapter';
import { TodoView } from '../TodoView';

function mockBackend(todo: TodoList | null): BackendAdapter {
  return {
    available: true,
    todoGet: vi.fn(async () => todo ?? { thread_id: 't1', entries: [], total: 0 }),
  } as unknown as BackendAdapter;
}

const SAMPLE: TodoList = {
  thread_id: 't1',
  total: 2,
  entries: [
    {
      id: 'task-0',
      title: '绑定 shell_exec',
      detail: 'request_tool 绑定后调用一次',
      priority: 'high',
      status: 'done',
      evidence: 'shell_exec 返回 exit 0',
      order: 0,
      created_at: 1700000000,
      updated_at: 1700000100,
      completed_at: 1700000100,
    },
    {
      id: 'task-1',
      title: '跑测试',
      detail: 'pytest 全部通过',
      priority: 'medium',
      status: 'pending',
      evidence: null,
      order: 1,
      created_at: 1700000000,
      updated_at: 1700000000,
      completed_at: null,
    },
  ],
};

describe('TodoView（待办清单页）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('宿主不可用 = 空态提示', () => {
    render(<TodoView backend={null} threadId="t1" />);
    expect(screen.getByText(/待办清单仅在宿主运行时可用/)).toBeTruthy();
  });

  it('空清单 = 空态引导', async () => {
    render(<TodoView backend={mockBackend(null)} threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText(/暂无待办/)).toBeTruthy();
    });
  });

  it('渲染条目：标题/状态/证据/计数', async () => {
    render(<TodoView backend={mockBackend(SAMPLE)} threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText('绑定 shell_exec')).toBeTruthy();
      expect(screen.getByText('跑测试')).toBeTruthy();
    });
    expect(screen.getByText(/2 项 · 1 待办 · 1 完成/)).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('待办')).toBeTruthy();
    expect(screen.getByText(/证据：shell_exec 返回 exit 0/)).toBeTruthy();
    expect(screen.getByText('request_tool 绑定后调用一次')).toBeTruthy();
  });

  it('刷新调用 todoGet', async () => {
    const backend = mockBackend(SAMPLE);
    render(<TodoView backend={backend} threadId="t1" />);
    await waitFor(() => {
      expect(backend.todoGet).toHaveBeenCalledWith('t1');
    });
  });
});
