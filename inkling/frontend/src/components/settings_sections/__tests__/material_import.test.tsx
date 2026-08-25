/**
 * 既有资料批量导入面板测试：不可用回落 / 扫描预览 / 入料 / 错误反馈 / 目录选择。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { BackendAdapter, MaterialImportResult, MaterialScanResult } from '@/shared/backend/backendAdapter';
import { MaterialImportPanel } from '../material_import';

vi.mock('@/shared/media/filePicker', () => ({
  createDomDirectoryPicker: () => ({
    pick: async () => [{ name: 'a.md', size: 1, path: '/home/u/docs/a.md' }],
  }),
}));

function ui(name: string): HTMLElement {
  const el = document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
  if (!el) throw new Error(`缺 data-ui 元素: ${name}`);
  return el;
}

const scanResult: MaterialScanResult = {
  root: '/home/u/docs',
  recursive: false,
  scanned: 2,
  files: [
    { path: '/home/u/docs/a.md', format: 'md', size: 10 },
    { path: '/home/u/docs/b.json', format: 'json', size: 20 },
  ],
  skipped: [{ path: '/home/u/docs/c.bin', reason: '不支持的格式: bin' }],
};

const importResult: MaterialImportResult = {
  scanned: 2,
  ingested: 1,
  rejected: 1,
  files: [
    { path: '/home/u/docs/a.md', status: 'ingested' },
    { path: '/home/u/docs/b.json', status: 'rejected', reason: '网关拒绝' },
  ],
};

function mockBackend(over: Partial<BackendAdapter> = {}): BackendAdapter {
  return {
    available: true,
    materialScan: vi.fn(async () => scanResult),
    materialIngest: vi.fn(async () => importResult),
    ...over,
  } as unknown as BackendAdapter;
}

describe('MaterialImportPanel', () => {
  it('无后端时回落不可用提示', () => {
    render(<MaterialImportPanel materialImport={undefined} />);
    expect(screen.getByText(/导入操作面不可用/)).toBeTruthy();
  });

  it('扫描预览调用后端并展示归一清单', async () => {
    const backend = mockBackend();
    render(<MaterialImportPanel materialImport={backend} />);
    await userEvent.type(ui('material_import_path'), '/home/u/docs');
    await userEvent.click(ui('material_import_scan'));
    await waitFor(() => expect(backend.materialScan).toHaveBeenCalledWith('/home/u/docs', false));
    expect(screen.getByText(/扫描 2 件/)).toBeTruthy();
    expect(screen.getByText(/\[md\] \/home\/u\/docs\/a.md/)).toBeTruthy();
    expect(screen.getByText(/跳过 \/home\/u\/docs\/c.bin/)).toBeTruthy();
  });

  it('导入入库调用后端并展示逐文件状态', async () => {
    const backend = mockBackend();
    render(<MaterialImportPanel materialImport={backend} />);
    await userEvent.type(ui('material_import_path'), '/home/u/docs');
    await userEvent.click(ui('material_import_ingest'));
    await waitFor(() => expect(backend.materialIngest).toHaveBeenCalledWith('/home/u/docs', false));
    expect(screen.getByText(/入料完成 · 已入 1 件 · 拒绝 1 件/)).toBeTruthy();
    expect(screen.getByText(/拒绝 \/home\/u\/docs\/b.json/)).toBeTruthy();
  });

  it('后端报错时展示错误反馈', async () => {
    const backend = mockBackend({
      materialScan: vi.fn(async () => {
        throw new Error('路径不在允许导入根内');
      }),
    });
    render(<MaterialImportPanel materialImport={backend} />);
    await userEvent.type(ui('material_import_path'), '/etc');
    await userEvent.click(ui('material_import_scan'));
    await waitFor(() => expect(screen.getByText(/路径不在允许导入根内/)).toBeTruthy());
  });

  it('浏览目录拾取后回填目录路径', async () => {
    const backend = mockBackend();
    render(<MaterialImportPanel materialImport={backend} />);
    await userEvent.click(ui('material_import_browse'));
    await waitFor(() => expect(ui('material_import_path').getAttribute('value')).toBe('/home/u/docs'));
  });
});
