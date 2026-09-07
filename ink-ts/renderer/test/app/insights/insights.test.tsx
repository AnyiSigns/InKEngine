import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InsightSection } from '@/app/insights/InsightSection';
import { describeEntry, detailText, isAlertType, TYPE_LABELS } from '@/app/insights/labels';

describe('InsightSection（事件时间线）', () => {
  it('空数据态', async () => {
    render(<InsightSection />);
    expect(await screen.findByText(/暂无引擎活动记录/)).toBeInTheDocument();
    expect(screen.getByText('洞察')).toBeInTheDocument();
  });

  it('顶栏操作区存在（筛选/刷新/导出）', async () => {
    render(<InsightSection />);
    expect(await screen.findByText('洞察')).toBeInTheDocument();
    expect(screen.getByLabelText('按类型筛选')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /刷新/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导出/ })).toBeInTheDocument();
  });
});

describe('labels', () => {
  it('类型短标签', () => {
    expect(TYPE_LABELS.assembly_candidate).toBe('组装候选');
    expect(TYPE_LABELS.patch_reverted).toBe('补丁回退');
  });

  it('describeEntry 优先 reason/action，缺省回落类型名', () => {
    expect(describeEntry('policy_edge_review', { reason: '失败超阈值' })).toBe('策略边复审：失败超阈值');
    expect(describeEntry('assembly_candidate', { candidate_id: 'c1' })).toBe('组装候选：c1');
    expect(describeEntry('unknown_kind', {})).toBe('unknown_kind');
  });

  it('detailText 只挑已知字段拼可读文本', () => {
    const text = detailText({ type: 'x', ts: 1, reason: '原因', trace_id: 't-1', other: '忽略' });
    expect(text).toContain('理由: 原因');
    expect(text).toContain('trace: t-1');
    expect(text).not.toContain('忽略');
    expect(text).not.toContain('type');
  });

  it('isAlertType 对回退/失败与拦截类判定', () => {
    expect(isAlertType('revert', {})).toBe(true);
    expect(isAlertType('patch_reverted', {})).toBe(true);
    expect(isAlertType('failure_audit', {})).toBe(true);
    expect(isAlertType('gate_verdict', { passed: false })).toBe(true);
    expect(isAlertType('gate_verdict', { passed: true })).toBe(false);
    expect(isAlertType('assembly_audit', {})).toBe(false);
  });
});
