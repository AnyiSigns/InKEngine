/**
 * 「审计与恢复」设置节交互测试（mock 后端真链断言，W2 会话上下文）：
 * - 审计导出：audit.list 返回 → JSON 下载触发；canDownload=false 明确失败不报假成功；
 * - 会话链回退：以当前活动会话 thread_id 查询/回退；二次确认后才调用 rollback；
 * - 无活动会话 = 空态文案，不触发宿主调用；
 * - 出厂重置：须输入确认词「重置」才调用 factory_reset。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let auditRecords: unknown[] = [{ type: 'patch_applied', ts: 1700000000 }];
let points: Array<{ checkpoint_id: number; parent_id: number | null; reason: string | null; graph_path: string[] }> = [
  { checkpoint_id: 3, parent_id: 2, reason: 'round', graph_path: [] },
  { checkpoint_id: 2, parent_id: 1, reason: 'round', graph_path: [] },
  { checkpoint_id: 1, parent_id: null, reason: 'boot', graph_path: [] },
];

const backendMock = {
  available: true,
  auditList: vi.fn(async () => ({ records: auditRecords })),
  recoverySnapshots: vi.fn(async () => ({ thread_id: 'thread-a', latest: 3, points })),
  recoveryRestoreSnapshot: vi.fn(async () => ({ thread_id: 'thread-a', target: 2, deleted: [3], current_leaf: 2 })),
  recoveryFactoryReset: vi.fn(async () => ({ reverted_patches: [], overwritten: false })),
};

vi.mock('@/shared/backend/backendAdapter', () => ({
  createBackend: () => backendMock,
}));

import { setActiveThreadId } from '@app/state/activeThread';
import { AuditRecoverySection } from './audit_recovery';

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
  points = [
    { checkpoint_id: 3, parent_id: 2, reason: 'round', graph_path: [] },
    { checkpoint_id: 2, parent_id: 1, reason: 'round', graph_path: [] },
    { checkpoint_id: 1, parent_id: null, reason: 'boot', graph_path: [] },
  ];
  setActiveThreadId('thread-a');
  backendMock.auditList.mockClear();
  backendMock.recoverySnapshots.mockClear();
  backendMock.recoveryRestoreSnapshot.mockClear();
  backendMock.recoveryFactoryReset.mockClear();
});

afterEach(() => {
  setActiveThreadId('');
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

describe('AuditRecoverySection 会话链回退（thread 上下文）', () => {
  it('以当前活动会话 thread_id 查询回退点；二次确认后才调用 rollback', async () => {
    const user = userEvent.setup();
    render(<AuditRecoverySection />);
    expect(await screen.findByText(/#3/)).toBeInTheDocument();
    expect(backendMock.recoverySnapshots).toHaveBeenCalledWith('thread-a');

    await user.click(screen.getByRole('button', { name: '回退链尾' }));
    expect(backendMock.recoveryRestoreSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /确认回退链尾/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /确认回退链尾/ }));
    expect(backendMock.recoveryRestoreSnapshot).toHaveBeenCalledWith('thread-a');
    expect(await screen.findByText('已回退到上一检查点')).toBeInTheDocument();
    expect(backendMock.recoverySnapshots.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('无活动会话 = 空态文案，不触发宿主回退点调用', async () => {
    setActiveThreadId('');
    render(<AuditRecoverySection />);
    expect(await screen.findByText(/无活动会话上下文/)).toBeInTheDocument();
    expect(backendMock.recoverySnapshots).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /回退链尾/ })).toBeNull();
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
