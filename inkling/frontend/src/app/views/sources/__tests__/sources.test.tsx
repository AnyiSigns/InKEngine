import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SourcesView } from '@/app/views/sources/SourcesView';
import { createMockSourceBackend } from '@/app/views/sources/mockBackend';
import type { SourceEntry } from '@/app/views/sources/backend';

const entries: SourceEntry[] = [
  { id: 's1', type: 'step', title: '步骤一', detail: '执行了 X', time: 1, confidence: 0.9, raw: { event: 'node_start', node: 'n1' } },
  { id: 's2', type: 'recall', title: '召回记忆', detail: '命中 2 条', time: 2 },
];

describe('来源·六 tab + 账本', () => {
  it('六 tab 可切换', async () => {
    const user = userEvent.setup();
    render(<SourcesView backend={createMockSourceBackend({ ledger: { snapshots: 7, chainSegments: 3 }, sources: { round_steps: entries } })} />);
    for (const id of ['round_steps', 'memory_recall', 'tuning', 'vetting', 'device_sensed', 'device_control']) {
      expect(screen.getByTestId(`src-tab-${id}`)).toBeInTheDocument();
    }
    expect(await screen.findByTestId('src-entry-s1')).toBeInTheDocument();
    await user.click(screen.getByTestId('src-tab-memory_recall'));
    expect(await screen.findByText('暂无来源数据')).toBeInTheDocument();
  });

  it('账本摘要卡「本轮事实快照 N 条 · 摘要链 M 段」', async () => {
    render(<SourcesView backend={createMockSourceBackend({ ledger: { snapshots: 7, chainSegments: 3 } })} />);
    expect(await screen.findByTestId('ledger-summary')).toHaveTextContent('本轮事实快照 7 条');
    expect(screen.getByTestId('ledger-summary')).toHaveTextContent('摘要链 3 段');
  });

  it('机器术语豁免层：可展开原始事件', async () => {
    const user = userEvent.setup();
    render(<SourcesView backend={createMockSourceBackend({ ledger: { snapshots: 7, chainSegments: 3 }, sources: { round_steps: entries } })} />);
    await user.click(await screen.findByTestId('src-raw-s1'));
    const block = await screen.findByTestId('src-raw-block');
    expect(block).toHaveTextContent('node_start');
  });

  it('轮次回放抽屉（回合编号 + 摘要 + 成本 + 结论）', async () => {
    const user = userEvent.setup();
    render(
      <SourcesView
        backend={createMockSourceBackend({
          ledger: { snapshots: 7, chainSegments: 3 },
          rounds: { 'round-7': { roundId: 'round-7', summary: '完成研究', cost: 14, conclusion: '已验证', time: 1 } },
        })}
      />,
    );
    await user.click(await screen.findByTestId('ledger-replay'));
    const drawer = await screen.findByTestId('replay-drawer');
    expect(within(drawer).getByText('完成研究')).toBeInTheDocument();
    expect(within(drawer).getByText('已验证')).toBeInTheDocument();
  });
});
