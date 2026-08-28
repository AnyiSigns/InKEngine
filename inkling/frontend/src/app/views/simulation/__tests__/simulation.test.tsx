import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SimulationView } from '@/app/views/simulation/SimulationView';
import { createMockSimulationBackend } from '@/app/views/simulation/mockBackend';
import type { SimulationState } from '@/app/views/simulation/backend';

const state: SimulationState = {
  policy: 'full',
  groups: [
    {
      kind: 'replan',
      candidates: [
        { id: 'c1', branch: 1, title: '路径甲', score: 0.8, rounds: 2, cost: 12, summary: '甲', selected: false },
        { id: 'c2', branch: 2, title: '路径乙', score: 0.6, rounds: 1, cost: 8, summary: '乙', selected: false, diff: '~ change' },
      ],
    },
  ],
  chosenId: null,
};

describe('推演·分支对比 + 换选', () => {
  it('档位指示 off/light/full', async () => {
    render(<SimulationView backend={createMockSimulationBackend({ state })} />);
    expect(await screen.findByTestId('sim-policy')).toHaveAttribute('data-policy', 'full');
  });

  it('换选确认三按钮（确认/取消/取消选择）', async () => {
    const user = userEvent.setup();
    render(<SimulationView backend={createMockSimulationBackend({ state })} />);
    await user.click(await screen.findByTestId('candidate-swap-c1'));
    const confirm = await screen.findByTestId('swap-confirm');
    expect(within(confirm).getByTestId('swap-confirm-btn')).toBeInTheDocument();
    expect(within(confirm).getByTestId('swap-cancel')).toBeInTheDocument();
    expect(within(confirm).getByTestId('swap-clear')).toBeInTheDocument();
    await user.click(within(confirm).getByTestId('swap-confirm-btn'));
    expect(await screen.findByTestId('candidate-c1')).toHaveAttribute('data-selected', 'true');
  });

  it('取消选择回退到无候选', async () => {
    const user = userEvent.setup();
    render(<SimulationView backend={createMockSimulationBackend({ state })} />);
    await user.click(await screen.findByTestId('candidate-swap-c1'));
    await user.click(await screen.findByTestId('swap-clear'));
    expect(screen.queryByTestId('swap-confirm')).not.toBeInTheDocument();
  });

  it('差异折叠可展开', async () => {
    const user = userEvent.setup();
    render(<SimulationView backend={createMockSimulationBackend({ state })} />);
    await user.click(await screen.findByTestId('candidate-diff-toggle'));
    expect(screen.getByTestId('candidate-diff')).toHaveTextContent('~ change');
  });
});

describe('推演·空态', () => {
  it('无决策点→空态「本回合无推演决策点」+ 档位入口', async () => {
    render(<SimulationView backend={createMockSimulationBackend({ state: { policy: 'off', groups: [], chosenId: null } })} />);
    expect(await screen.findByText('本回合无推演决策点')).toBeInTheDocument();
  });
});
