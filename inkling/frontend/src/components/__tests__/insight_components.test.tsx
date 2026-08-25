/**
 * Why / 主权 / 情境建议 组件测试：空态与数据态渲染。
 */

import { render, screen } from '@testing-library/react';

import { WhyPanel } from '@/components/why_panel';
import { SovereigntyView } from '@/components/sovereignty_view';
import { SuggestionBar } from '@/components/suggestion_bar';

describe('WhyPanel', () => {
  it('空数据态', () => {
    render(<WhyPanel bindValue={null} />);
    expect(screen.getByText(/暂无.*留痕数据/)).toBeInTheDocument();
  });

  it('渲染决策点理由链与边证据', () => {
    render(
      <WhyPanel
        bindValue={{
          domain: 'default',
          reason_chain: [
            {
              type: 'policy_edge_review',
              reason: '策略边失败累计超阈值',
              action: 'downgraded_to_statistical',
              review_tier: 'l2',
            },
          ],
          candidates: [{ candidate_id: 'c1', domain: 'default', chain: ['a', 'b'] }],
          edge_evidence: [
            { src_type: 'x', dst_type: 'y', success_count: 9, fail_count: 1, policy: true },
          ],
        }}
      />,
    );
    expect(screen.getByText(/决策点理由链/)).toBeInTheDocument();
    expect(screen.getByText(/策略边失败累计超阈值/)).toBeInTheDocument();
    expect(screen.getByText(/候选卡/)).toBeInTheDocument();
    expect(screen.getByText('x→y')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
  });
});

describe('SovereigntyView', () => {
  it('空数据态', () => {
    render(<SovereigntyView bindValue={null} />);
    expect(screen.getByText(/本地数据资产/)).toBeInTheDocument();
  });

  it('渲染存储位置与挡位', () => {
    render(
      <SovereigntyView
        bindValue={{
          local_storage: { backend: 'SqliteStorage', location: '/data/ink.db' },
          skill_store_path: '/data/skills.db',
          model_tiers: ['main', 'router'],
          audit_total: 3,
          audit_counts: { op: 3 },
        }}
      />,
    );
    expect(screen.getByText(/SqliteStorage/)).toBeInTheDocument();
    expect(screen.getByText(/\/data\/ink\.db/)).toBeInTheDocument();
    expect(screen.getByText(/router/)).toBeInTheDocument();
    expect(screen.getAllByText(/main/).length).toBeGreaterThan(0);
    expect(screen.getByText(/共 3 条/)).toBeInTheDocument();
  });
});

describe('SuggestionBar', () => {
  it('空数据态', () => {
    render(<SuggestionBar bindValue={{ suggestions: [] }} />);
    expect(screen.getByText(/暂无主动建议/)).toBeInTheDocument();
  });

  it('渲染命中建议', () => {
    render(
      <SuggestionBar
        bindValue={{
          suggestions: [
            { rule_id: 'rule.context.idle_distraction', message: '归并通知', severity: 'info' },
          ],
        }}
      />,
    );
    expect(screen.getByText('rule.context.idle_distraction')).toBeInTheDocument();
    expect(screen.getByText('归并通知')).toBeInTheDocument();
  });
});
