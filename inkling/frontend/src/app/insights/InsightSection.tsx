/**
 * 洞察 = 引擎自进化事件时间线（实时事件流 + 审计历史底账）。
 *
 * 数据面：
 * - 历史底账：`audit.list` 读取 set_audit 集合（append-only 干预/自修改留痕）；
 * - 实时流：订阅宿主 round_event 通道，过滤自进化相关事件类型即时追加。
 * 全部只读：刷新 = 重新拉历史合并，导出 = 当前视图 TSV 下载。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Eye, RefreshCw } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { cn } from '@/shared/cn';
import { listenHostEvent } from '@/shared/backend/tauriBridge';
import { toHubEvent } from '@/shared/session/eventIngest';
import type { HubEvent } from '@/shared/session/channelHub';
import { listAudit, type AuditRecord, type TimelineEntry } from './backend';
import { describeEntry, detailText, isAlertType, TYPE_LABELS } from './labels';

/** 实时流关注的自进化事件类型（与审计留痕面同域，排除对话/流式噪音）。 */
const LIVE_TYPES = new Set([
  'assembly_candidate',
  'junction_verdict',
  'junction_verdict_audit',
  'assembly_audit',
  'fingerprint_replace_audit',
  'policy_edge_review_audit',
  'recommended_prior_promotion',
  'signal_detected',
  'distill_outcome',
  'gate_verdict',
  'evolution_variant',
  'mutation_proposed',
  'regression_guard',
  'patch_proposed',
  'patch_applied',
  'patch_reverted',
  'tuning_update',
  'vetting_result',
  'node_start',
]);

/** 时间线条目容量上限（防长会话无限增长）。 */
const MAX_ENTRIES = 500;

function toMs(ts?: number): number {
  if (!ts) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

function entryKey(entry: TimelineEntry): string {
  return `${entry.type}|${entry.ts}|${entry.title}`;
}

function buildHistory(records: AuditRecord[]): TimelineEntry[] {
  return records
    .map((raw) => {
      const type = String(raw.type ?? raw.kind ?? 'unknown');
      const entry: TimelineEntry = {
        id: `h-${raw.trace_id ?? raw.ts ?? Date.now()}-${type}`,
        ts: toMs(raw.ts),
        type,
        title: describeEntry(type, raw),
        detail: detailText(raw),
        raw,
        source: 'history',
      };
      return entry;
    })
    .sort((a, b) => b.ts - a.ts);
}

function mergeEntries(prev: TimelineEntry[], history: TimelineEntry[]): TimelineEntry[] {
  const byKey = new Map<string, TimelineEntry>();
  for (const entry of history) byKey.set(entryKey(entry), entry);
  for (const entry of prev) {
    const key = entryKey(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ENTRIES);
}

function fmtTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function InsightSection() {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const records = await listAudit();
      if (records) setEntries((prev) => mergeEntries(prev, buildHistory(records)));
    } finally {
      setLoading(false);
    }
  }, []);

  const appendLive = useCallback((event: HubEvent) => {
    setEntries((prev) => {
      const entry: TimelineEntry = {
        id: `l-${event.at}-${event.type}`,
        ts: event.at,
        type: event.type,
        title: describeEntry(event.type, event.payload),
        detail: detailText(event.payload),
        raw: { ...event.payload, type: event.type },
        source: 'live',
      };
      const key = entryKey(entry);
      if (prev.some((e) => entryKey(e) === key)) return prev;
      const merged = [...prev, entry].sort((a, b) => b.ts - a.ts);
      return merged.slice(0, MAX_ENTRIES);
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 实时事件流：订阅宿主 round_event 通道（与会话驱动侧监听独立互不影响）。
  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    void listenHostEvent<Record<string, unknown>>('inkling://round_event', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const event = toHubEvent(raw as Record<string, unknown>);
      if (!LIVE_TYPES.has(event.type)) return;
      if (alive) appendLive(event);
    }).then((u) => {
      if (alive) unsub = u;
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [appendLive]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const visible = filter ? entries.filter((e) => e.type === filter) : entries;

  const handleExport = () => {
    const lines = visible.map(
      (e) =>
        `${new Date(e.ts).toLocaleString()}\t${e.type}\t${e.title.replace(/\t/g, ' ')}\t${e.raw.trace_id ?? ''}`,
    );
    const header = '时间\t类型\t动作\ttrace_id\n';
    const blob = new Blob([header + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audit_export.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div data-ui="insight_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Eye size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">洞察</h3>
        <span className="rounded border border-[var(--ink-border)] px-1.5 py-px text-[9px] text-[var(--ink-text-faint)]">
          {entries.length} 条
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <select
            data-ui="insight_type_filter"
            aria-label="按类型筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-6 rounded-lg border border-[var(--ink-border)] bg-[var(--ink-bg-elevated)] px-1.5 text-[11px] text-[var(--ink-text-base)] outline-none"
          >
            <option value="">全部类型</option>
            {typeCounts.map(([type, count]) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type] ?? type}（{count}）
              </option>
            ))}
          </select>
          <Button size="xs" variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={10} strokeWidth={1.6} />
            刷新
          </Button>
          <Button size="xs" variant="secondary" onClick={handleExport} disabled={visible.length === 0}>
            <Download size={10} strokeWidth={1.6} />
            导出
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          暂无引擎活动记录
          <div className="mt-1 text-[10px]">
            引擎的自进化/干预动作（组装候选、策略边复审、知识落位、补丁回退等）会实时出现在这里
          </div>
        </div>
      ) : (
        <ol className="flex flex-col">
          {visible.map((entry, index) => {
            const alert = isAlertType(entry.type, entry.raw);
            return (
              <li key={entry.id} className="relative flex items-start gap-3 pl-4 pb-2.5">
                {index < visible.length - 1 && (
                  <span
                    className="absolute left-[5px] top-3 h-[calc(100%-10px)] w-px bg-[var(--ink-border)]"
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    'absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full border',
                    alert
                      ? 'border-[var(--ink-accent-border)] bg-[var(--ink-accent-approval)]'
                      : entry.source === 'live'
                        ? 'border-[var(--ink-border-strong)] bg-[var(--ink-accent-approval)]'
                        : 'border-[var(--ink-border-strong)] bg-[var(--ink-bg-elevated)]',
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-[9px] text-[var(--ink-text-faint)]">
                      {fmtTime(entry.ts)}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-md border px-1.5 py-px text-[9px]',
                        alert
                          ? 'border-[var(--ink-accent-border)] text-[var(--ink-accent-approval)]'
                          : 'border-[var(--ink-border)] text-[var(--ink-text-muted)]',
                      )}
                    >
                      {TYPE_LABELS[entry.type] ?? entry.type}
                    </span>
                    {entry.source === 'live' && (
                      <span className="shrink-0 rounded-md bg-[var(--ink-accent-approval)]/10 px-1 py-px text-[9px] text-[var(--ink-accent-approval)]">
                        实时
                      </span>
                    )}
                    <span className="truncate text-[11px] text-[var(--ink-text-base)]">
                      {entry.title}
                    </span>
                  </div>
                  {entry.detail ? (
                    <details className="mt-0.5">
                      <summary className="cursor-pointer text-[9px] text-[var(--ink-text-faint)]">
                        详情
                      </summary>
                      <pre className="mt-1 whitespace-pre-wrap rounded border border-[var(--ink-border)] bg-[var(--ink-bg-elevated)] px-2 py-1 font-mono text-[9px] leading-relaxed text-[var(--ink-text-muted)]">
                        {entry.detail}
                      </pre>
                    </details>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
