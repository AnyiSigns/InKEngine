/**
 * 仪表测试：喂 path.assemble 统计 + TurnMetrics 快照 → 缓存命中率 /
 * LLM 调用数 / 边平均成本渲染正确；无宿主回落不崩。
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Dashboard } from '@/components/dashboard';
import type { AssembleStats, TurnMetricsSnapshot } from '@/shared/backend/backendAdapter';

const METRICS: TurnMetricsSnapshot = {
  turns: 12,
  failures: 1,
  failure_rate: 0.0833,
  avg_review_score: 0.91,
  llm_calls: 47,
  round_duration_ms: 3250,
};

const STATS: AssembleStats = {
  cache_hits: 80,
  cache_misses: 20,
  cache_invalidations: 2,
  cache_replacements: 1,
  avg_cost: 0.42,
};

describe('仪表：指标渲染', () => {
  it('缓存命中率 = hits/(hits+misses)', () => {
    render(<Dashboard metrics={METRICS} assembleStats={STATS} />);
    expect(screen.getByText('80.0%')).toBeInTheDocument();
  });

  it('LLM 调用数渲染', () => {
    render(<Dashboard metrics={METRICS} assembleStats={STATS} />);
    expect(screen.getByText('47')).toBeInTheDocument();
  });

  it('边平均成本渲染', () => {
    render(<Dashboard metrics={METRICS} assembleStats={STATS} />);
    expect(screen.getByText('0.420')).toBeInTheDocument();
  });

  it('回合耗时与失败率渲染', () => {
    render(<Dashboard metrics={METRICS} assembleStats={STATS} />);
    expect(screen.getByText('3.3s')).toBeInTheDocument();
    expect(screen.getByText(/失败率 8%/)).toBeInTheDocument();
  });

  it('模型占用联动显示', () => {
    render(
      <Dashboard
        metrics={METRICS}
        assembleStats={STATS}
        models={{ profiles: [{ id: 'a', name: 'A', tier: 'main', occupancy: 2, limit: 8 }] }}
      />,
    );
    expect(screen.getByText(/模型占用 2\/8/)).toBeInTheDocument();
  });
});

describe('仪表：无宿主回落不崩', () => {
  it('无注入无宿主显示占位零值', () => {
    render(<Dashboard />);
    expect(screen.getByText('成本与性能')).toBeInTheDocument();
    expect(screen.getByText('无宿主 · 占位')).toBeInTheDocument();
    // 命中率占位为 0.0%
    expect(screen.getByText('0.0%')).toBeInTheDocument();
  });
});
