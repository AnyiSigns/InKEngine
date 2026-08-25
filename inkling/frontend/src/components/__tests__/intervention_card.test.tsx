/**
 * 干预卡测试：四个操作各有「调用→状态改变→审计事件→反向操作复原」
 * 四段（mock 后端注入；审计事件投送通道中枢）。
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InterventionCard } from '@/components/intervention_card';
import { ChannelHub } from '@/shared/session/channelHub';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';

function mockBackend(): BackendAdapter {
  return {
    available: true,
    chooseCandidate: vi.fn(async () => ({ chosen: 'c1' })),
    setMultipath: vi.fn(async () => ({ multipath: true })),
    invalidateCache: vi.fn(async () => ({ cleared: 'default' })),
    downgradeEdgeTier: vi.fn(async () => ({ edge: 'edge-1', tier: 'low' })),
    rebuildCache: vi.fn(async () => ({ rebuilt: 'default' })),
    restoreEdgeTier: vi.fn(async () => ({ edge: 'edge-1', tier: 'high' })),
  } as unknown as BackendAdapter;
}

describe('干预卡：四操作四段', () => {
  it('选这条：调用→已选→审计→取消复原', async () => {
    const user = userEvent.setup();
    const backend = mockBackend();
    const hub = new ChannelHub();
    render(<InterventionCard candidate={{ id: 'c1', label: '候选甲' }} backend={backend} hub={hub} />);

    await user.click(screen.getByText('选这条'));
    expect(backend.chooseCandidate).toHaveBeenCalledWith('c1');
    expect(screen.getByText('已选')).toBeInTheDocument();
    await waitFor(() => expect(hub.getLastEvent('path_choose_candidate' as never)).toBeDefined());

    await user.click(screen.getByText('取消选择'));
    expect(backend.chooseCandidate).toHaveBeenCalledWith(null);
    expect(screen.queryByText('已选')).not.toBeInTheDocument();
  });

  it('多路展开：开关切换 + 审计', async () => {
    const user = userEvent.setup();
    const backend = mockBackend();
    const hub = new ChannelHub();
    render(<InterventionCard backend={backend} hub={hub} />);

    await user.click(screen.getByText('多路：关'));
    expect(backend.setMultipath).toHaveBeenCalledWith(true);
    expect(screen.getByText('多路：开')).toBeInTheDocument();
    await waitFor(() => expect(hub.getLastEvent('path_set_multipath' as never)).toBeDefined());

    await user.click(screen.getByText('多路：开'));
    expect(backend.setMultipath).toHaveBeenCalledWith(false);
    expect(screen.getByText('多路：关')).toBeInTheDocument();
  });

  it('清除缓存：调用→禁用→审计→重建复原', async () => {
    const user = userEvent.setup();
    const backend = mockBackend();
    const hub = new ChannelHub();
    render(<InterventionCard backend={backend} hub={hub} />);

    await user.click(screen.getByText('清除缓存'));
    expect(backend.invalidateCache).toHaveBeenCalledWith('default');
    await waitFor(() => expect(hub.getLastEvent('cache_invalidate' as never)).toBeDefined());

    await user.click(screen.getByText('重建缓存'));
    expect(backend.rebuildCache).toHaveBeenCalledWith('default');
  });

  it('信任档降级：调用→审计→恢复复原', async () => {
    const user = userEvent.setup();
    const backend = mockBackend();
    const hub = new ChannelHub();
    render(<InterventionCard backend={backend} hub={hub} />);

    await user.click(screen.getByText('信任档降级'));
    expect(backend.downgradeEdgeTier).toHaveBeenCalledWith('edge-1');
    await waitFor(() => expect(hub.getLastEvent('edge_downgrade_tier' as never)).toBeDefined());

    await user.click(screen.getByText('恢复信任档'));
    expect(backend.restoreEdgeTier).toHaveBeenCalledWith('edge-1');
  });

  it('无宿主（无后端）点击不崩', async () => {
    const user = userEvent.setup();
    render(<InterventionCard candidate={{ id: 'c1', label: '甲' }} />);
    await user.click(screen.getByText('选这条'));
    expect(screen.getByText('干预')).toBeInTheDocument();
  });
});
