/**
 * 成本与性能仪表：回合耗时 / LLM 调用数 / 缓存命中率 / 边平均成本。
 *
 * 数据来源钉死：
 * - 缓存命中率取 path.assemble op 回传的 stats（cache_hits/cache_misses/
 *   cache_invalidations/cache_replacements）——不引用任何缓存存储内部
 *   API，仅消费 op 回传聚合统计；
 * - 其余指标取自 TurnMetrics 快照（turns/failures/failure_rate/
 *   avg_review_score + 扩展面 llm_calls/round_duration_ms）。
 *
 * 数据源优先 props 注入（测试/mock 直喂），缺省回落后端适配器异步拉取；
 * 无宿主且无注入 = 占位零值，不崩。
 */

import { useEffect, useState } from 'react';

import type { AssembleStats, BackendAdapter, ModelsSnapshot, TurnMetricsSnapshot } from '@/shared/backend/backendAdapter';
import { createBackend } from '@/shared/backend/backendAdapter';

export interface DashboardProps {
  /** 注入指标快照（优先于后端拉取） */
  metrics?: TurnMetricsSnapshot;
  /** 注入组装统计（缓存命中率/边成本来源） */
  assembleStats?: AssembleStats;
  /** 注入模型档案（占用/上限联动显示） */
  models?: ModelsSnapshot;
  /** 可注入后端（缺省 = 全局后端选择） */
  backend?: BackendAdapter;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function hitRate(stats: AssembleStats | undefined): number {
  if (!stats) return 0;
  const total = stats.cache_hits + stats.cache_misses;
  if (total <= 0) return 0;
  return (stats.cache_hits / total) * 100;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border ink-border px-3 py-2" data-ui="metric">
      <div className="text-[9px] ink-text-faint">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tracking-tight" data-ui="metric_value">
        {value}
      </div>
      {hint ? <div className="text-[9px] ink-text-faint">{hint}</div> : null}
    </div>
  );
}

/** 成本与性能仪表（状态卡片：四指标 + 模型占用联动）。 */
export function Dashboard({ metrics, assembleStats, models, backend }: DashboardProps) {
  const resolvedBackend = backend ?? createBackend();
  const [remoteMetrics, setRemoteMetrics] = useState<TurnMetricsSnapshot | undefined>(metrics);
  const [remoteStats, setRemoteStats] = useState<AssembleStats | undefined>(assembleStats);
  const [remoteModels, setRemoteModels] = useState<ModelsSnapshot | undefined>(models);

  useEffect(() => {
    let alive = true;
    if (metrics == null && resolvedBackend.available) {
      void resolvedBackend.metricsSnapshot().then((m) => {
        if (alive) setRemoteMetrics(m);
      }).catch(() => undefined);
    }
    if (assembleStats == null && resolvedBackend.available) {
      void resolvedBackend.assembleStats().then((s) => {
        if (alive) setRemoteStats(s);
      }).catch(() => undefined);
    }
    if (models == null && resolvedBackend.available) {
      void resolvedBackend.modelsSnapshot().then((m) => {
        if (alive) setRemoteModels(m);
      }).catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [metrics, assembleStats, models, resolvedBackend]);

  const finalMetrics = remoteMetrics ?? metrics;
  const finalStats = remoteStats ?? assembleStats;
  const finalModels = remoteModels ?? models;

  const rate = hitRate(finalStats);
  const totalOccupancy = (finalModels?.profiles ?? []).reduce((sum, p) => sum + Math.max(0, p.occupancy), 0);
  const totalLimit = (finalModels?.profiles ?? []).reduce((sum, p) => sum + Math.max(0, p.limit), 0);

  return (
    <section className="ink-panel p-3" data-ui="dashboard">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold tracking-tight">成本与性能</span>
        {!resolvedBackend.available && !metrics && !assembleStats ? (
          <span className="ml-auto text-[9px] ink-text-faint">无宿主 · 占位</span>
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Metric
          label="回合耗时"
          value={formatDuration(finalMetrics?.round_duration_ms ?? 0)}
          hint={finalMetrics ? `回合 ${finalMetrics.turns} · 失败率 ${(finalMetrics.failure_rate * 100).toFixed(0)}%` : undefined}
        />
        <Metric
          label="LLM 调用数"
          value={String(finalMetrics?.llm_calls ?? 0)}
          hint={finalMetrics ? `均分 ${(finalMetrics.avg_review_score ?? 0).toFixed(2)}` : undefined}
        />
        <Metric
          label="缓存命中率"
          value={`${rate.toFixed(1)}%`}
          hint={finalStats ? `命中 ${finalStats.cache_hits} · 失 ${finalStats.cache_misses}` : undefined}
        />
        <Metric
          label="边平均成本"
          value={finalStats ? finalStats.avg_cost.toFixed(3) : '--'}
          hint={finalStats ? `顶替 ${finalStats.cache_replacements} · 失效 ${finalStats.cache_invalidations}` : undefined}
        />
      </div>

      {finalModels ? (
        <div className="mt-2 text-[10px] ink-text-muted" data-ui="model_occupancy">
          模型占用 {totalOccupancy}/{totalLimit}
        </div>
      ) : null}
    </section>
  );
}
