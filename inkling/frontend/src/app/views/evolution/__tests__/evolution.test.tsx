import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EvolutionView } from '@/app/views/evolution/EvolutionView';
import { ProposalCard } from '@/app/views/evolution/ProposalCard';
import { createMockEvolutionBackend } from '@/app/views/evolution/mockBackend';
import type {
  Convergence,
  EvolutionProposal,
  IncubationState,
  KnowledgeCandidate,
  TimelineNode,
  EvolutionVariant,
} from '@/app/views/evolution/backend';

const incubation: IncubationState = {
  signals: [
    { type: 'pitfall', count: 3, examples: [{ event: 'e1', confidence: 0.8 }] },
    { type: 'insight', count: 1, examples: [] },
  ],
  distill: { summary: ' distilled', evidenceCount: 5 },
  gate: { verdict: 'pass', note: '通过' },
};

const convergence: Convergence = {
  rounds: { current: 2, total: 2 },
  dimensions: [
    { name: '相关性', score: 0.9, threshold: 0.75, passed: true },
    { name: '准确性', score: 0.6, threshold: 0.75, passed: false },
  ],
  failing: ['准确性'],
  beam: { candidateA: 0.82, candidateB: 0.55 },
};

const variants: EvolutionVariant[] = [{ id: 'v1', label: '变体 X', summary: '候选演化' }];

describe('演化·孵化三段 + 信号', () => {
  it('三阶段卡 + 信号 chip 点击打开来源抽屉', async () => {
    const user = userEvent.setup();
    render(<EvolutionView backend={createMockEvolutionBackend({ incubation, variants })} />);
    expect(await screen.findByTestId('incubation')).toBeInTheDocument();
    expect(screen.getByTestId('gate-verdict')).toHaveTextContent('通过');
    await user.click(screen.getByTestId('signal-pitfall'));
    expect(await screen.findByTestId('signal-example')).toHaveTextContent('e1');
  });
});

describe('演化·提案分级', () => {
  it('L0 直过（静默，仅徽标）', () => {
    const p: EvolutionProposal = { id: 'p0', level: 0, title: '小修' };
    render(<ProposalCard proposal={p} onApply={() => undefined} onRevert={() => undefined} onEdit={() => undefined} />);
    expect(screen.getByTestId('proposal-level')).toHaveTextContent('审批 · L0');
    expect(screen.getByText('直过')).toBeInTheDocument();
  });

  it('L1 弹卡（diff + 接受/拒绝/编辑）', () => {
    const p: EvolutionProposal = { id: 'p1', level: 1, title: '提案1', diff: [{ op: 'add', text: '+ x' }] };
    render(<ProposalCard proposal={p} onApply={() => undefined} onRevert={() => undefined} onEdit={() => undefined} />);
    expect(screen.getByTestId('proposal-level')).toHaveTextContent('审批 · L1');
    expect(screen.getByTestId('proposal-diff')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-accept')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-edit')).toBeInTheDocument();
  });

  it('L2 沙箱确认（试跑结果 + 朱砂徽标）', () => {
    const p: EvolutionProposal = { id: 'p2', level: 2, title: '提案2', sandboxResult: '试跑通过' };
    render(<ProposalCard proposal={p} onApply={() => undefined} onRevert={() => undefined} onEdit={() => undefined} />);
    expect(screen.getByTestId('proposal-level')).toHaveTextContent('审批 · L2');
    expect(screen.getByTestId('proposal-level')).toHaveClass('w3-badge--approval');
    expect(screen.getByTestId('proposal-sandbox')).toHaveTextContent('试跑通过');
  });

  it('收敛轮次 / 维度分 / failing / Beam', () => {
    const p: EvolutionProposal = { id: 'p2', level: 2, title: '提案2', sandboxResult: '试跑通过' };
    render(<ProposalCard proposal={p} convergence={convergence} onApply={() => undefined} onRevert={() => undefined} onEdit={() => undefined} />);
    expect(screen.getByTestId('convergence-rounds')).toHaveTextContent('轮次 · 2/2');
    expect(screen.getByTestId('convergence-failing')).toHaveTextContent('准确性');
    expect(screen.getByTestId('convergence-beam')).toHaveTextContent('A 0.82');
  });
});

describe('演化·知识 L3 人工评审（回写）', () => {
  it('闸门 · L3 弹层 + 确认放行调用 releaseKnowledge', async () => {
    const user = userEvent.setup();
    const release = vi.fn();
    const candidate: KnowledgeCandidate = {
      id: 'k1',
      content: '候选知识',
      dimensions: [{ name: '可信', score: 0.9, threshold: 0.75, passed: true }],
    };
    const backend = { ...createMockEvolutionBackend({ knowledge: [candidate] }), releaseKnowledge: release };
    render(<EvolutionView backend={backend} />);
    await user.click(await screen.findByTestId('knowledge-k1'));
    const floater = await screen.findByTestId('knowledge-floater');
    expect(within(floater).getByText('闸门 · L3')).toBeInTheDocument();
    await user.click(within(floater).getByTestId('knowledge-release'));
    expect(release).toHaveBeenCalledWith('k1', undefined);
  });
});

describe('演化·时间线 + evolution_factory 独立渲染', () => {
  it('时间线实心/分叉 + 变体独立渲染器', async () => {
    const user = userEvent.setup();
    const timeline: TimelineNode[] = [
      { id: 't1', version: 'v1', solid: true },
      { id: 't2', version: 'v2', solid: false, fork: true, diff: [{ op: 'mod', text: '~ y' }] },
    ];
    render(<EvolutionView backend={createMockEvolutionBackend({ timeline, variants })} />);
    expect(await screen.findByTestId('tl-node-t1')).toHaveAttribute('data-solid', 'true');
    expect(screen.getByTestId('tl-node-t2')).toHaveAttribute('data-fork', 'true');
    const variant = await screen.findByTestId('evolution-variant');
    expect(variant).toHaveAttribute('data-renderer', 'evolution_factory');
    await user.click(screen.getByTestId('tl-node-t2'));
    expect(await screen.findByTestId('tl-drawer')).toBeInTheDocument();
  });
});

describe('演化·空态', () => {
  it('无数据→空态「用得越多，它越懂你的领域」', () => {
    render(<EvolutionView backend={createMockEvolutionBackend({ incubation: null, proposals: null, timeline: null, variants: null })} />);
    expect(screen.getByText('用得越多，它越懂你的领域')).toBeInTheDocument();
  });
});
