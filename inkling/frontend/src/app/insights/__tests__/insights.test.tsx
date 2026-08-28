import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WhyPanel } from '../WhyPanel';
import { SovereigntyView } from '../SovereigntyView';
import { SuggestionBar } from '../SuggestionBar';

describe('WhyPanel', () => {
  it('空数据态', () => {
    render(<WhyPanel data={null} />);
    expect(screen.getByText(/暂无.*留痕数据/)).toBeInTheDocument();
  });

  it('渲染决策点理由链与边证据', () => {
    render(
      <WhyPanel
        data={{
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
    render(<SovereigntyView data={null} />);
    expect(screen.getByText(/本地数据资产/)).toBeInTheDocument();
  });

  it('渲染存储位置与挡位', () => {
    render(
      <SovereigntyView
        data={{
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
    render(<SuggestionBar data={{ suggestions: [] }} />);
    expect(screen.getByText(/暂无主动建议/)).toBeInTheDocument();
  });

  it('渲染命中建议', () => {
    render(
      <SuggestionBar
        data={{
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
