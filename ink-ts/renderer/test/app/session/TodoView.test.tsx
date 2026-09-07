/**
 * 待办清单页测试：rounds.todos 投影行渲染/状态标记/空态/宿主不可用。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import { TodoView } from '@/app/session/TodoView';

function mockBackend(todo: Array<{ id: string; label: string; status: string; kind: string }> | null): BackendAdapter {
  return {
    available: true,
    todoGet: vi.fn(async () => ({ thread_id: 't1', todo: todo ?? [] })),
  } as unknown as BackendAdapter;
}

const SAMPLE = [
  { id: 'plan:1', label: 'intent_parse → answer_generate', status: 'pending', kind: 'nodes' },
  { id: 'review-1', label: '审批待裁决: shell_exec', status: 'pending', kind: 'approval' },
];

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

  it('渲染条目：计划步骤 + 审批卡 + 计数', async () => {
    render(<TodoView backend={mockBackend(SAMPLE)} threadId="t1" />);
    await waitFor(() => {
      expect(screen.getByText(/intent_parse → answer_generate/)).toBeTruthy();
      expect(screen.getByText(/shell_exec/)).toBeTruthy();
    });
    expect(screen.getByText(/2 项 · 2 待办/)).toBeTruthy();
    expect(screen.getByText('审批待裁决')).toBeTruthy();
    expect(screen.getByText(/含 1 条挂起审批卡/)).toBeTruthy();
  });

  it('刷新调用 todoGet', async () => {
    const backend = mockBackend(SAMPLE);
    render(<TodoView backend={backend} threadId="t1" />);
    await waitFor(() => {
      expect(backend.todoGet).toHaveBeenCalledWith('t1');
    });
  });
});
