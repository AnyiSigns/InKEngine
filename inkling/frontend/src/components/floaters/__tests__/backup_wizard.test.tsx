/**
 * 备份/恢复向导测试：导出/恢复双模式、校验预览、恢复前快照提示、
 * 宿主操作经可注入 ops（mock 后端）下发。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BackupWizard, backupOpsFrom, type BackupOps } from '../backup_wizard';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';

const ops: BackupOps = {
  exportTo: vi.fn(async (dest) => ({ entries: 5, size: 2048, has_db: true })),
  preview: vi.fn(async () => ({ entries_total: 5, will_overwrite: 3, total_size: 2048, has_db: true, created_at: 1000 })),
  restore: vi.fn(async () => ({ restored_entries: 5, snapshot: 'C:\\snap\\pre-restore-1' })),
};

describe('备份向导（导出模式）', () => {
  it('导出路径 → 开始导出 → 结果反馈', async () => {
    const user = userEvent.setup();
    render(<BackupWizard mode="export" onClose={() => undefined} ops={ops} />);
    await user.type(screen.getByLabelText('备份路径'), 'C:\\backup.inkbk');
    await user.click(screen.getByText('开始导出'));
    expect(await screen.findByText(/已导出 5 个文件/)).toBeInTheDocument();
    expect(ops.exportTo).toHaveBeenCalledWith('C:\\backup.inkbk');
  });

  it('无 ops（宿主不可用）= 失败反馈不静默', async () => {
    const user = userEvent.setup();
    render(<BackupWizard mode="export" onClose={() => undefined} ops={null} />);
    await user.type(screen.getByLabelText('备份路径'), 'C:\\x.inkbk');
    await user.click(screen.getByText('开始导出'));
    expect(await screen.findByText(/操作失败/)).toBeInTheDocument();
  });
});

describe('恢复向导（恢复模式）', () => {
  it('预览 → 执行恢复（恢复前快照提示随预览出现）', async () => {
    const user = userEvent.setup();
    render(<BackupWizard mode="restore" onClose={() => undefined} ops={ops} />);
    await user.type(screen.getByLabelText('备份路径'), 'C:\\backup.inkbk');
    await user.click(screen.getByText('校验并预览'));
    expect(await screen.findByText(/条目 5 · 覆盖 3/)).toBeInTheDocument();
    expect(screen.getByText(/恢复前将自动快照当前态/)).toBeInTheDocument();
    await user.click(screen.getByText('执行恢复'));
    expect(await screen.findByText(/已恢复 5 个文件/)).toBeInTheDocument();
    expect(ops.restore).toHaveBeenCalledWith('C:\\backup.inkbk');
  });

  it('未预览 = 执行按钮禁用（fail-closed）', () => {
    render(<BackupWizard mode="restore" onClose={() => undefined} ops={ops} />);
    const run = screen.getByText('执行恢复') as HTMLButtonElement;
    expect(run.disabled).toBe(true);
  });
});

describe('备份操作装配', () => {
  it('宿主不可用 = 空 ops；宿主可用 = 后端命令直调', async () => {
    expect(backupOpsFrom(null)).toBeNull();
    const backend = {
      available: true,
      backupExport: vi.fn(async () => ({ entries: 1, size: 1, has_db: true })),
      backupPreview: vi.fn(),
      backupRestore: vi.fn(),
    } as unknown as BackendAdapter;
    const wired = backupOpsFrom(backend);
    expect(wired).not.toBeNull();
    await wired?.exportTo('C:\\a.inkbk');
    expect(backend.backupExport).toHaveBeenCalledWith('C:\\a.inkbk');
  });
});
