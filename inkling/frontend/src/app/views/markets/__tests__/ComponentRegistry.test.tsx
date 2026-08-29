import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ComponentRegistry } from '../ComponentRegistry';
import { createAppBackend, type AppBackend } from '../../../backend';
import type { AppArtifactEntry } from '../../../types';

function makeMockBackend(entries: AppArtifactEntry[] = []): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  vi.spyOn(backend, 'getComponentsManifest').mockResolvedValue(entries);
  vi.spyOn(backend, 'refreshComponentManifest').mockResolvedValue(entries);
  vi.spyOn(backend, 'syncUiComponentGate').mockResolvedValue();
  return backend;
}

const sampleEntries: AppArtifactEntry[] = [
  {
    name: 'focus_dashboard',
    url: 'https://cdn.test/focus_dashboard.js',
    hash: 'abc123',
    version: '0.1.0',
    renderer_key: 'widget.focus',
  },
  {
    name: 'page_clipper',
    url: 'artifacts/js_bundle-9f26/focus.js',
    hash: 'def456',
    version: '0.3.0',
  },
];

describe('ComponentRegistry (组件清单：出厂 + 已挂载双源)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染出厂组件区与已挂载组件区（双源合并，来源 chip 区分）', async () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentRegistry backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('出厂组件')).toBeTruthy();
      expect(screen.getByText('已挂载组件')).toBeTruthy();
      expect(screen.getByText('focus_dashboard')).toBeTruthy();
      expect(screen.getByText('page_clipper')).toBeTruthy();
    });
    // 来源 chip：出厂 factory / 已挂载 patch_chain
    expect(screen.getAllByText('factory').length).toBeGreaterThan(0);
    expect(screen.getAllByText('patch_chain').length).toBeGreaterThan(0);
    // 出厂契约清单（manifest renderer_components 真源）逐项展示
    expect(screen.getByText('message_list')).toBeTruthy();
    expect(screen.getByText('view_header')).toBeTruthy();
  });

  it('出厂组件计数（N 出厂 · M 已挂载）', async () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentRegistry backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText(/2 已挂载/)).toBeTruthy();
    });
    expect(screen.getByText(/出厂 · 2 已挂载/)).toBeTruthy();
  });

  it('挂载刷新 artifactLoader 注册（refreshComponentManifest 被调用）', async () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentRegistry backend={backend} />);

    await waitFor(() => {
      expect(backend.refreshComponentManifest).toHaveBeenCalled();
    });
  });

  it('renderer_key 展示为白名单键', async () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentRegistry backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('widget.focus')).toBeTruthy();
    });
  });

  it('空态显示「暂无已挂载组件」', async () => {
    const backend = makeMockBackend([]);
    render(<ComponentRegistry backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('暂无已挂载组件')).toBeTruthy();
    });
  });

  it('本地产物路径条目同样列出（哈希前缀展示）', async () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentRegistry backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText(/def456/)).toBeTruthy();
    });
  });

  it('停用出厂组件 → 调用 setUiComponentsDisabled 并同步渲染白名单', async () => {
    const backend = makeMockBackend(sampleEntries);
    const setSpy = vi.spyOn(backend, 'setUiComponentsDisabled').mockResolvedValue({
      ok: true,
      disabled: ['message_list'],
    });
    render(<ComponentRegistry backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('message_list')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('factory_component_message_list'));

    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith(['message_list']);
    });
    expect(backend.syncUiComponentGate).toHaveBeenCalled();
    // 停用后行内态更新
    expect(screen.getAllByText('已停用').length).toBeGreaterThan(0);
  });
});
