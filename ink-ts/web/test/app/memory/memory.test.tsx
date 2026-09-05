import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { sourceLabel, kindLabel } from '@/app/memory/backend';

type MemoryRecord = {
  id: string;
  namespace: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  credibility: number;
  expires_at: number | null;
  created_at: number;
};

function buildEntry(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'e1',
    namespace: 'user:default',
    kind: 'decision',
    title: '决策',
    content: '内容',
    source: 'manual',
    credibility: 0.9,
    expires_at: null,
    created_at: 1,
    ...over,
  };
}

let records: MemoryRecord[] = [];
const backendMock = {
  available: true,
  memoryList: vi.fn(async () => ({ namespaces: [{ name: 'user:default', count: records.length }], entries: records })),
  memoryInvalidate: vi.fn(async (id: string) => {
    records = records.filter((e) => e.id !== id);
    return { id, invalidated: true };
  }),
  memoryUpdateFrontmatter: vi.fn(async () => ({})),
};

vi.mock('@/shared/backend/backendAdapter', () => ({
  createBackend: () => backendMock,
}));

import { MemoryView } from '@/app/memory/MemoryView';

function rowUi(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`[data-ui="memory_entry_${id}"]`) as HTMLElement;
}

async function expandEntry(container: HTMLElement, id: string) {
  const row = rowUi(container, id);
  const toggle = row.querySelector('button') as HTMLElement;
  await userEvent.click(toggle);
}

describe('MemoryView 空态', () => {
  beforeEach(() => {
    records = [];
    backendMock.memoryList.mockClear();
    backendMock.memoryInvalidate.mockClear();
  });

  it('空态渲染', async () => {
    render(<MemoryView />);
    expect(await screen.findByText(/尚无记忆/)).toBeInTheDocument();
  });
});

describe('MemoryView 删除二次确认', () => {
  beforeEach(() => {
    records = [buildEntry()];
    backendMock.memoryList.mockClear();
    backendMock.memoryInvalidate.mockClear();
  });

  it('确认前不调用失效 op，且展示「永久删除，不可恢复」确认', async () => {
    const user = userEvent.setup();
    const { container } = render(<MemoryView />);
    await screen.findAllByText('决策');
    await expandEntry(container, 'e1');
    const row = rowUi(container, 'e1');
    await user.click(row.querySelector('[data-ui="memory_invalidate"]') as HTMLElement);
    expect(backendMock.memoryInvalidate).not.toHaveBeenCalled();
    expect(screen.getByText(/永久删除，不可恢复/)).toBeInTheDocument();
    expect(screen.getByText('确认永久删除')).toBeInTheDocument();
  });

  it('确认后调用失效 op 并刷新列表（条目消失 + 不可恢复反馈）', async () => {
    const user = userEvent.setup();
    const { container } = render(<MemoryView />);
    await screen.findAllByText('决策');
    await expandEntry(container, 'e1');
    const row = rowUi(container, 'e1');
    await user.click(row.querySelector('[data-ui="memory_invalidate"]') as HTMLElement);
    await user.click(screen.getByText('确认永久删除'));
    expect(backendMock.memoryInvalidate).toHaveBeenCalledWith('e1');
    expect(backendMock.memoryList).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('内容')).not.toBeInTheDocument();
    expect(await screen.findByText(/不可恢复/)).toBeInTheDocument();
  });

  it('取消确认后不调用失效 op，条目保留', async () => {
    const user = userEvent.setup();
    const { container } = render(<MemoryView />);
    await screen.findAllByText('决策');
    await expandEntry(container, 'e1');
    const row = rowUi(container, 'e1');
    await user.click(row.querySelector('[data-ui="memory_invalidate"]') as HTMLElement);
    await user.click(screen.getByText('取消'));
    expect(backendMock.memoryInvalidate).not.toHaveBeenCalled();
    expect(screen.getByText('内容')).toBeInTheDocument();
  });
});

describe('sourceLabel', () => {
  it('round_liquid 提取', () => {
    expect(sourceLabel('round_liquid')).toBe('round_liquid 提取');
  });
  it('人工录入', () => {
    expect(sourceLabel('manual')).toBe('人工录入');
  });
  it('种子数据', () => {
    expect(sourceLabel('seed')).toBe('种子数据');
  });
});

describe('kindLabel', () => {
  it('决策', () => {
    expect(kindLabel('decision')).toBe('决策');
  });
  it('领域窗口', () => {
    expect(kindLabel('domain_window')).toBe('领域窗口');
  });
});
