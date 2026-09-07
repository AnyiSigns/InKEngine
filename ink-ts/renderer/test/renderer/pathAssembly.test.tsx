/**
 * 路径装配渲染器测试：注册入口 + 人话中文标签 + 折叠展开 + 空态防崩。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  AssemblyCandidateCard,
  registerPathAssemblyRenderers,
} from '@/renderer/pathAssembly';
import { isComponentRegistered } from '@/renderer/componentRegistry';

const CANDIDATE_EVENT = {
  type: 'assembly_candidate',
  at: 1_800_000_000_000,
  payload: {
    ts: 1_800_000_000_000,
    domain: 'research',
    fingerprint: 'abc123',
    goal_fields: ['answer'],
    entry_fields: ['query'],
    candidates: [
      {
        rank: 1,
        source: 'algorithm',
        repaired: false,
        score: 0.0666,
        chain: ['intent_parse', 'answer_generate'],
        graph: { name: 'assembly.1.research' },
      },
    ],
    llm_attempts: 0,
    fallback_reason: null,
    stats: { beam_extensions: 3, edge_score_calls: 2 },
  },
};

describe('注册入口：渲染组件进动态注册表', () => {
  it('组装候选卡片注册（同名覆盖幂等）', () => {
    registerPathAssemblyRenderers();
    expect(isComponentRegistered('assembly_candidate_card')).toBe(true);
  });
});

describe('组装候选卡片：透明状态卡片 + 折叠展开', () => {
  it('人话中文标签：域/候选数/时间', () => {
    render(<AssemblyCandidateCard bindValue={CANDIDATE_EVENT} />);
    expect(screen.getByText('组装候选')).toBeInTheDocument();
    expect(screen.getByText('research')).toBeInTheDocument();
    expect(screen.getByText('候选 1 条')).toBeInTheDocument();
  });

  it('折叠展开：默认收起，展开后可见候选链与目标字段', async () => {
    const user = userEvent.setup();
    render(<AssemblyCandidateCard bindValue={CANDIDATE_EVENT} />);
    expect(screen.queryByText('intent_parse → answer_generate')).not.toBeInTheDocument();
    await user.click(screen.getByText(/候选明细/));
    expect(screen.getByText('intent_parse → answer_generate')).toBeInTheDocument();
    expect(screen.getByText('目标覆盖：answer')).toBeInTheDocument();
  });

  it('无事件（空态）不崩且给空态文案', () => {
    render(<AssemblyCandidateCard />);
    expect(screen.getByText(/暂无候选/)).toBeInTheDocument();
    expect(screen.getByText('组装候选')).toBeInTheDocument();
  });

  it('兜底原因以朱砂口径展示', () => {
    render(
      <AssemblyCandidateCard
        bindValue={{ ...CANDIDATE_EVENT, payload: { ...CANDIDATE_EVENT.payload, candidates: [], fallback_reason: '草稿非法且修复不可达' } }}
      />,
    );
    expect(screen.getByText(/兜底：草稿非法且修复不可达/)).toBeInTheDocument();
  });
});
