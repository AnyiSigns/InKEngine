/**
 * 安全信任节崩溃回退测试：快照刷新/回上一稳定版本/出厂重置（两步确认）、
 * 宿主操作经可注入 recovery ops（mock 后端）下发。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SecurityTrust, recoveryOpsFrom, type RecoveryOps } from '../security_trust';
import { DEFAULT_SECURITY } from '../security_trust';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';

const ops: RecoveryOps = {
  status: vi.fn(async () => ({ engine_ready: true, tool_count: 10, safe_mode: false })),
  snapshots: vi.fn(async () => ({
    snapshots: [
      { name: 'chain-v5-1720000001000-a.sqlite', chain_version: 5, created_at: 1720000001000 },
      { name: 'chain-v4-1719999999000-b.sqlite', chain_version: 4, created_at: 1719999999000 },
    ],
  })),
  restore: vi.fn(async () => ({ restored: 'chain-v5-1720000001000-a.sqlite', chain_version: 5 })),
  factoryReset: vi.fn(async () => ({ reverted_patches: [5, 4, 3], overwritten: false })),
};

function ui(name: string): HTMLElement {
  const el = document.querySelector(`[data-ui="${name}"]`) as HTMLElement | null;
  if (!el) throw new Error(`缺 data-ui 元素: ${name}`);
  return el;
}

function renderSecurityTrust(recovery: RecoveryOps | null = ops) {
  return render(
    <SecurityTrust
      value={DEFAULT_SECURITY}
      patch={() => undefined}
      recovery={recovery}
    />,
  );
}

describe('安全信任节崩溃回退', () => {
  it('刷新快照 → 列表展示（链版本 + 时间）', async () => {
    const user = userEvent.setup();
    renderSecurityTrust();
    await user.click(ui('recovery_refresh'));
    expect(await screen.findByText(/chain-v5-1720000001000-a\.sqlite/)).toBeInTheDocument();
    expect(screen.getByText(/v5 ·/)).toBeInTheDocument();
    expect(ops.snapshots).toHaveBeenCalledTimes(1);
  });

  it('回上一稳定版本 = 两步确认 → 恢复最新快照 → 成功反馈', async () => {
    const user = userEvent.setup();
    renderSecurityTrust();
    await user.click(ui('recovery_refresh'));
    await screen.findByText(/chain-v5/);
    await user.click(ui('recovery_restore'));
    expect(screen.getByText(/确认回到上一稳定版本/)).toBeInTheDocument();
    await user.click(ui('recovery_restore'));
    expect(await screen.findByText(/已恢复到上一稳定版本/)).toBeInTheDocument();
    expect(ops.restore).toHaveBeenCalledWith('chain-v5-1720000001000-a.sqlite');
  });

  it('出厂重置 = 两步确认 → 逐尾回退至基线', async () => {
    const user = userEvent.setup();
    renderSecurityTrust();
    await user.click(ui('recovery_factory_reset'));
    expect(screen.getByText(/确认出厂重置/)).toBeInTheDocument();
    await user.click(ui('recovery_factory_reset'));
    expect(await screen.findByText(/已重置为出厂基线/)).toBeInTheDocument();
    expect(ops.factoryReset).toHaveBeenCalledTimes(1);
  });

  it('安全模式徽标（宿主 status.safe_mode = true）', async () => {
    const user = userEvent.setup();
    const safeOps: RecoveryOps = {
      ...ops,
      status: vi.fn(async () => ({ engine_ready: true, tool_count: 10, safe_mode: true })),
    };
    renderSecurityTrust(safeOps);
    await user.click(ui('recovery_refresh'));
    await waitFor(() => {
      expect(document.querySelector('[data-ui="recovery_safe_mode_badge"]')).not.toBeNull();
    });
  });

  it('无宿主（recovery = null）= 操作失败反馈不静默', async () => {
    const user = userEvent.setup();
    renderSecurityTrust(null);
    await user.click(ui('recovery_refresh'));
    expect(await screen.findByText(/快照读取失败/)).toBeInTheDocument();
  });

  it('recoveryOpsFrom 仅宿主可用时构造操作面', () => {
    const availableBackend = {
      available: true,
      status: vi.fn(),
      recoverySnapshots: vi.fn(),
      recoveryRestoreSnapshot: vi.fn(),
      recoveryFactoryReset: vi.fn(),
    } as unknown as BackendAdapter;
    const built = recoveryOpsFrom(availableBackend);
    expect(built).not.toBeNull();
    expect(recoveryOpsFrom(null)).toBeNull();
    expect(recoveryOpsFrom({ ...availableBackend, available: false })).toBeNull();
  });
});
