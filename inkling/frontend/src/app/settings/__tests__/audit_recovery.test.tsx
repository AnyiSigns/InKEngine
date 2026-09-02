/**
 * 「审计与恢复」生产设置节交互测试（mock 后端真链断言）：
 * - 审计导出：audit.list 返回 → JSON 下载触发；canDownload=false 明确失败不报假成功；
 * - 快照恢复：列表装载 → 二次确认后才调用 restore，完成后刷新；
 * - 出厂重置：须输入确认词「重置」才调用 factory_reset。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let auditRecords: unknown[] = [{ type: 'patch_applied', ts: 1700000000 }];
let snapshots: Array<{ name: string; chain_version: number; created_at: number }> = [
  { name: 'chain-v3-1700000000000-abc.sqlite', chain_version: 3, created_at: 1700000000000 },
];

const backendMock = {
  available: true,
  auditList: vi.fn(async () => auditRecords),
  recoverySnapshots: vi.fn(async () => ({ snapshots })),
  recoveryRestoreSnapshot: vi.fn(async (name: string) => ({ restored: name, chain_version: 3 })),
  recoveryFactoryReset: vi.fn(async () => ({ reverted_patches: [], overwritten: false })),
};

vi.mock('@/shared/backend/backendAdapter', () => ({
  createBackend: () => backendMock,
}));

import { AuditRecoverySection } from '@/app/settings/sections/audit_recovery';

function stubDownloadCapable() {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:inkling-audit'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
}

function unstubDownload() {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

beforeEach(() => {
  auditRecords = [{ type: 'patch_applied', ts: 1700000000 }];
  snapshots = [{ name: 'chain-v3-1700000000000-abc.sqlite', chain_version: 3, created_at: 1700000000000 }];
  backendMock.auditList.mockClear();
  backendMock.recoverySnapshots.mockClear();
  backendMock.recoveryRestoreSnapshot.mockClear();
  backendMock.recoveryFactoryReset.mockClear();
});

afterEach(() => {
  unstubDownload();
});

describe('AuditRecoverySection 审计导出', () => {
  it('audit.list 返回 → 触发 JSON 下载并显示成功', async () => {
    const user = userEvent.setup();
    stubDownloadCapable();
    render(<AuditRecoverySection />);
    await user.click(screen.getByRole('button', { name: /导出审计 JSON/ }));
    expect(backendMock.auditList).toHaveBeenCalledWith({ limit: 2000 });
    expect(await screen.findByText(/已导出 1 条审计记录/)).toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('canDownload=false 时明确失败，不报假成功', async () => {
    const user = userEvent.setup();
    render(<AuditRecoverySection />);
    await user.click(screen.getByRole('button', { name: /导出审计 JSON/ }));
    expect(backendMock.auditList).not.toHaveBeenCalled();
    const feedback = await screen.findByText(/导出失败/);
    expect(feedback.textContent).toContain('下载能力不可用');
  });
});

describe('AuditRecoverySection 快照恢复', () => {
  it('装载后展示快照；二次确认后才调用 restore，完成后刷新', async () => {
    const user = userEvent.setup();
    render(<AuditRecoverySection />);
    const name = 'chain-v3-1700000000000-abc.sqlite';
    expect(await screen.findByText(name)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '恢复到上一稳定版本' }));
    expect(backendMock.recoveryRestoreSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /确认恢复/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /确认恢复/ }));
    expect(backendMock.recoveryRestoreSnapshot).toHaveBeenCalledWith(name);
    expect(await screen.findByText('已恢复到上一稳定版本')).toBeInTheDocument();
    expect(backendMock.recoverySnapshots.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('无快照时恢复入口不存在并提示', async () => {
    snapshots = [];
    render(<AuditRecoverySection />);
    expect(await screen.findByText(/暂无启动快照/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /恢复到上一稳定版本/ })).toBeNull();
  });
});

describe('AuditRecoverySection 出厂重置确认流', () => {
  it('未输入确认词不调用；输入「重置」后调用 factory_reset', async () => {
    const user = userEvent.setup();
    render(<AuditRecoverySection />);
    const resetButton = await screen.findByRole('button', { name: /确认出厂重置/ });
    await user.click(resetButton);
    expect(backendMock.recoveryFactoryReset).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('重置确认词'), '重置');
    await user.click(resetButton);
    expect(backendMock.recoveryFactoryReset).toHaveBeenCalled();
    expect(await screen.findByText('已重置为出厂基线')).toBeInTheDocument();
  });
});
