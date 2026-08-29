import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { ComponentRegistry } from '../ComponentRegistry';
import { createAppBackend, type AppBackend } from '../../../backend';
import type { AppArtifactEntry } from '../../../types';

function makeMockBackend(entries: AppArtifactEntry[] = []): AppBackend {
  const backend = createAppBackend({ backend: { available: false } as never });
  vi.spyOn(backend, 'getComponentsManifest').mockResolvedValue(entries);
  vi.spyOn(backend, 'refreshComponentManifest').mockResolvedValue(entries);
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

describe('ComponentRegistry (已注册组件清单)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染已注册组件清单（非市场目录）', async () => {
    const backend = makeMockBackend(sampleEntries);
    render(<ComponentRegistry backend={backend} />);

    await waitFor(() => {
      expect(screen.getByText('已注册组件')).toBeTruthy();
      expect(screen.getByText('focus_dashboard')).toBeTruthy();
      expect(screen.getByText('page_clipper')).toBeTruthy();
      expect(screen.getByText(/2 个已注册组件/)).toBeTruthy();
    });
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
});
