import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { UiEditorHost } from '@/app/views/uieditor/UiEditorHost';
import { createAppBackend, type AppBackend } from '@/app/backend';
import type { UISpec } from '@/renderer/uiSpecTypes';

const mockSpec: UISpec = {
  name: 'test.ui',
  version: 2,
  theme: { 'bg.base': '#000000', 'text.base': '#ffffff', 'accent.approval': '#ff9e0b' },
  root: {
    kind: 'container',
    type: 'column',
    children: [{ kind: 'component', type: 'message_list' }],
  },
};

function makeMockBackend(spec: UISpec | null = mockSpec): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  vi.spyOn(backend, 'getUiSpec').mockResolvedValue(spec);
  vi.spyOn(backend, 'saveUiSpec').mockResolvedValue({ applied: true });
  vi.spyOn(backend, 'revertUiSpec').mockResolvedValue({ reverted: true, chain_version: 1 });
  return backend;
}

describe('UiEditorHost (W4.1 / W4.2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染界面树编辑器标题', async () => {
    const backend = makeMockBackend();
    render(<UiEditorHost backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('界面树编辑器').length).toBeGreaterThan(0);
    });
  });

  it('从 inspect_ui 拉取 ui_spec → setLiveSpec', async () => {
    const backend = makeMockBackend();
    render(<UiEditorHost backend={backend} />);

    await waitFor(() => {
      expect(backend.getUiSpec).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByText(/test\.ui/)).toBeTruthy();
    });
  });

  it('ui_spec 缺失显示回退基线提示', async () => {
    const backend = makeMockBackend(null);
    render(<UiEditorHost backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('界面描述缺失或已损坏，已回退基线')).toBeTruthy();
    });
  });

  it('回退按钮触发 revertUiSpec', async () => {
    const backend = makeMockBackend();
    render(<UiEditorHost backend={backend} />);

    await waitFor(() => {
      expect(screen.getAllByText('界面树编辑器').length).toBeGreaterThan(0);
    });

    const revertBtns = screen.getAllByText('回退');
    fireEvent.click(revertBtns[0]!);

    await waitFor(() => {
      expect(backend.revertUiSpec).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByText('已回退到上一稳定版本')).toBeTruthy();
    });
  });

  it('应用保存触发 saveUiSpec', async () => {
    const backend = makeMockBackend();
    const onPatchApplied = vi.fn();
    render(<UiEditorHost backend={backend} onPatchApplied={onPatchApplied} />);

    await waitFor(() => {
      expect(screen.getAllByText('界面树编辑器').length).toBeGreaterThan(0);
    });

    const applyBtns = screen.getAllByText('应用');
    fireEvent.click(applyBtns[0]!);

    await waitFor(() => {
      expect(backend.saveUiSpec).toHaveBeenCalled();
    });
  });

  it('保存后 patch_applied 回調触发', async () => {
    const backend = makeMockBackend();
    const onPatchApplied = vi.fn();
    render(<UiEditorHost backend={backend} onPatchApplied={onPatchApplied} />);

    await waitFor(() => {
      expect(screen.getAllByText('界面树编辑器').length).toBeGreaterThan(0);
    });

    const applyBtns = screen.getAllByText('应用');
    fireEvent.click(applyBtns[0]!);

    await waitFor(() => {
      expect(onPatchApplied).toHaveBeenCalled();
    });
  });
});
