/**
 * 成本面（W2.5）：token 占比图 + CachingLLM 命中率 + 回合成本摘要 + 指标仪表盘。
 *
 * 数据源：tiers.snapshot / metrics.snapshot 桥数据 → SVG 自绘；
 * CachingLLM 命中率展示 + 清空按钮（壳命令 cache_invalidate）；
 * 指标：失败率/评审分/收敛轮数/缓存命中率/over_threshold 告警。
 *
 * 复用 src/shared/charts chart_spec + chart_export 自绘 SVG，禁新依赖。
 */

import { useEffect, useMemo, useState } from 'react';

import { RefreshCw, Trash2 } from 'lucide-react';

import { Button as InkButton } from '@/shared/ui/Button';
import { createBackend } from '@/shared/backend/backendAdapter';
import { buildChartSpec, type ChartSpec } from '@/shared/charts/chart_spec';
import { chartSpecToSvgString } from '@/shared/charts/chart_export';

interface MetricsSnapshot {
  turns: number;
  failures: number;
  failure_rate: number;
  avg_review_score: number;
  llm_calls: number;
  round_duration_ms: number;
  cache_hit_rate?: number;
  over_threshold?: boolean;
}

interface AssembleStats {
  cache_hits: number;
  cache_misses: number;
  cache_invalidations: number;
  cache_replacements: number;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function MiniBar({ value, max, label, warn }: { value: number; max: number; label: string; warn?: boolean }): JSX.Element {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="ink-text-muted">{label}</span>
        <span className={warn ? 'ink-text-accent' : 'ink-text-faint'}>{value.toLocaleString()}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--ink-bg-elevated)] overflow-hidden">
        <div
          className={['h-full rounded-full transition-all', warn ? 'bg-[var(--ink-accent-approval)]' : 'bg-[var(--ink-text-muted)]'].join(' ')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function CostDashboard(): JSX.Element {
  const backend = useMemo(() => createBackend(), []);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [stats, setStats] = useState<AssembleStats | null>(null);
  const [clearPhase, setClearPhase] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  const refresh = async (): Promise<void> => {
    if (!backend.available) return;
    try {
      const [m, s] = await Promise.all([
        backend.metricsSnapshot().then((r) => r as unknown as MetricsSnapshot),
        backend.assembleStats().then((r) => r as unknown as AssembleStats),
      ]);
      if (m) setMetrics(m);
      if (s) setStats(s);
    } catch {
      // 静默降级
    }
  };

  useEffect(() => {
    void refresh();
  }, [backend]);

  const tokenChart = useMemo<ChartSpec>(() => {
    if (!metrics) {
      return buildChartSpec({ type: 'bar', labels: ['回合'], series: [{ name: 'LLM 调用', values: [0] }] });
    }
    return buildChartSpec({
      type: 'bar',
      title: 'token 占比',
      labels: ['LLM 调用', '工具调用', '缓存命中'],
      series: [
        { name: 'LLM 调用', values: [metrics.llm_calls, metrics.turns, stats?.cache_hits ?? 0] },
      ],
    });
  }, [metrics, stats]);

  const svg = useMemo(() => chartSpecToSvgString(tokenChart), [tokenChart]);

  const handleClearCache = async (): Promise<void> => {
    setClearPhase('loading');
    try {
      if (backend.available) {
        await backend.invalidateCache('all');
      }
      setClearPhase('success');
      setTimeout(() => setClearPhase('idle'), 1200);
    } catch {
      setClearPhase('error');
      setTimeout(() => setClearPhase('idle'), 2000);
    }
  };

  const cacheTotal = stats ? stats.cache_hits + stats.cache_misses : 0;
  const cacheHitRate = stats && cacheTotal > 0 ? stats.cache_hits / cacheTotal : metrics?.cache_hit_rate ?? 0;

  return (
    <div className="space-y-4">
      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium tracking-wide ink-text-muted">回合成本摘要</div>
          <InkButton size="xs" variant="ghost" onClick={refresh} data-ui="cost_refresh">
            <RefreshCw size={10} strokeWidth={1.6} /> 刷新
          </InkButton>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-[10px] ink-text-faint">回合数</div>
            <div className="text-[var(--ink-font-xs)] font-medium">{metrics?.turns ?? '—'}</div>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] ink-text-faint">失败率</div>
            <div className={metrics && metrics.failure_rate > 0.2 ? 'text-[var(--ink-font-xs)] font-medium ink-text-accent' : 'text-[var(--ink-font-xs)] font-medium'}>
              {metrics ? formatPercent(metrics.failure_rate) : '—'}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] ink-text-faint">平均评审分</div>
            <div className="text-[var(--ink-font-xs)] font-medium">{metrics?.avg_review_score?.toFixed(2) ?? '—'}</div>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] ink-text-faint">回合耗时</div>
            <div className="text-[var(--ink-font-xs)] font-medium">{metrics?.round_duration_ms ? `${Math.round(metrics.round_duration_ms / 1000)}s` : '—'}</div>
          </div>
        </div>
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">缓存命中率</div>
        <MiniBar value={cacheHitRate} max={1} label="CachingLLM 命中率" warn={cacheHitRate < 0.3} />
        <div className="flex items-center gap-2">
          <InkButton size="xs" variant="ghost" onClick={handleClearCache} data-ui="cache_clear">
            <Trash2 size={10} strokeWidth={1.6} /> 清空缓存
          </InkButton>
          {clearPhase !== 'idle' && (
            <span className={[
              'text-[10px]',
              clearPhase === 'loading' ? 'ink-text-muted' : '',
              clearPhase === 'success' ? 'ink-feedback-ok' : '',
              clearPhase === 'error' ? 'ink-feedback-fail' : '',
            ].join(' ')}>
              {clearPhase === 'loading' && '清空中…'}
              {clearPhase === 'success' && '已清空'}
              {clearPhase === 'error' && '清空失败'}
            </span>
          )}
        </div>
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">token 占比</div>
        <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>

      <div className="ink-elevated space-y-3 px-3.5 py-3">
        <div className="text-[11px] font-medium tracking-wide ink-text-muted">指标仪表盘</div>
        <div className="space-y-2">
          <MiniBar value={metrics?.failures ?? 0} max={metrics?.turns ?? 1} label="失败次数" warn={(metrics?.failures ?? 0) / Math.max(1, metrics?.turns ?? 1) > 0.2} />
          <MiniBar value={metrics?.avg_review_score ?? 0} max={1} label="评审分" warn={(metrics?.avg_review_score ?? 1) < 0.6} />
          {metrics?.over_threshold && (
            <div className="ink-status-bubble px-2.5 py-1.5 text-[10px] ink-text-accent">
              告警：指标超过阈值（over_threshold）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
