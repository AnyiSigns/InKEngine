/**
 * 机制监控视图（演化页读取面归拢）：引擎机制读口只读投影。
 *
 * 数据 = host 已接读取面（W1）：metrics.snapshot / assemble.stats /
 * cache.stats / path.state / pool.snapshot / edge_evidence.list /
 * entities.snapshot。每读面一行摘要卡；available=false（机制未装配）或
 * 读取失败 = 结构化空态文案，不报错不白屏。宿主不可用 = 整页空态。
 */

import { useEffect, useState } from 'react';
import { Activity, Archive, Boxes, Database, GitBranch, Network, Route } from 'lucide-react';

import type { BackendAdapter } from '@/shared/backend/backendAdapter';

interface MechanismViewProps {
  backend: BackendAdapter | null;
  threadId: string;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface SummaryRow {
  label: string;
  value: string;
  tone: 'ok' | 'empty';
  detail?: string;
}

const emptyRow = (note: string): SummaryRow => ({ label: '未装配', value: '—', tone: 'empty', detail: note });

/** 各读面 → 摘要行（防御式字段收敛，结构不匹配 = 空态）。 */
function mapRead(key: string, raw: unknown): SummaryRow[] {
  const snap = asRecord(raw);
  switch (key) {
    case 'metrics': {
      if (!snap || snap['available'] !== true) return [emptyRow('metrics.snapshot 无装配')];
      return [
        { label: '回合', value: String(num(snap['rounds'])), tone: 'ok' },
        { label: '失败', value: String(num(snap['failures'])), tone: 'ok' },
        { label: '失败率', value: num(snap['avg']).toFixed(3), tone: 'ok' },
      ];
    }
    case 'assemble': {
      if (!snap || snap['available'] !== true) return [emptyRow('assemble.stats 无装配')];
      const stats = asRecord(snap['stats']);
      const rows: SummaryRow[] = [
        { label: '组装器', value: snap['assembler_enabled'] === true ? '开' : '关', tone: 'ok' },
        { label: '契约门', value: snap['contract_enabled'] === true ? '开' : '关', tone: 'ok' },
      ];
      if (stats) {
        const top = Object.entries(stats)
          .filter(([, v]) => typeof v === 'number')
          .slice(0, 3)
          .map(([k, v]) => `${k}:${String(v)}`)
          .join(' · ');
        if (top) rows.push({ label: '累计', value: top, tone: 'ok' });
      }
      return rows;
    }
    case 'cache': {
      const cache = snap ? asRecord(snap['fingerprint_cache']) : null;
      if (!cache || cache['available'] !== true) return [emptyRow('cache.stats 无装配')];
      const stats = asRecord(cache['stats']);
      return [
        { label: '条目', value: String(num(cache['entries'])), tone: 'ok' },
        { label: '查询', value: String(num(stats?.['lookups'])), tone: 'ok' },
        { label: '写库', value: String(num(stats?.['upserts'])), tone: 'ok' },
      ];
    }
    case 'path': {
      if (!snap || snap['available'] !== true) return [emptyRow('path.state 无装配')];
      const enabled = asRecord(snap['enabled']);
      const candidates = asRecord(snap['candidates']);
      return [
        { label: '装配器', value: enabled?.['assembler'] === true ? '开' : '关', tone: 'ok' },
        { label: '最近候选', value: String(num(candidates?.['last_assembly_count'] ?? 0)), tone: 'ok' },
        { label: 'canary 门', value: snap['canary_gate'] === true ? '开' : '关', tone: 'ok' },
      ];
    }
    case 'pool': {
      const counts = snap ? asRecord(snap['counts']) : null;
      if (!counts || snap?.['available'] !== true) return [emptyRow('pool.snapshot 无装配')];
      return [
        { label: '登记', value: String(num(counts['pool_count'])), tone: 'ok' },
        { label: '判定', value: String(num(counts['evaluations'])), tone: 'ok' },
        { label: '死结点候选', value: String(num(counts['dead_node_candidates'])), tone: 'ok' },
      ];
    }
    case 'edge': {
      if (!snap || snap['available'] !== true) return [emptyRow('edge_evidence.list 无装配')];
      const edges = Array.isArray(snap['edges']) ? (snap['edges'] as unknown[]) : [];
      return [
        { label: '边数', value: String(edges.length), tone: 'ok' },
        {
          label: '策略边',
          value: String(edges.filter((e) => asRecord(e)?.['policy'] === true).length),
          tone: 'ok',
        },
      ];
    }
    case 'entities': {
      if (!snap) return [emptyRow('entities.snapshot 无装配')];
      if (snap['available'] !== true || snap['degraded'] === true) {
        return [emptyRow('实体注册表未装配（degraded）')];
      }
      const max = snap['max'];
      return [
        { label: '实体', value: String(num(snap['count'])), tone: 'ok' },
        { label: '配额', value: typeof max === 'number' ? String(max) : '—', tone: 'ok' },
      ];
    }
    default:
      return [emptyRow(`${key} 读取面未登记`)];
  }
}

const READ_META = [
  { key: 'metrics', title: '回合指标', icon: Activity, method: 'metricsSnapshot' as const },
  { key: 'assemble', title: '组装链', icon: Archive, method: 'assembleStats' as const },
  { key: 'cache', title: '指纹缓存', icon: Database, method: 'cacheStats' as const },
  { key: 'path', title: '路径组装', icon: Route, method: 'pathState' as const },
  { key: 'pool', title: '结点池', icon: Boxes, method: 'poolSnapshot' as const },
  { key: 'edge', title: '边证据', icon: Network, method: 'edgeEvidenceList' as const },
  { key: 'entities', title: '实体注册表', icon: GitBranch, method: 'entitiesSnapshot' as const },
] as const;

const READ_METHODS: Record<string, (backend: BackendAdapter) => Promise<unknown>> = {
  metricsSnapshot: (backend) => backend.metricsSnapshot(),
  assembleStats: (backend) => backend.assembleStats(),
  cacheStats: (backend) => backend.cacheStats(),
  pathState: (backend) => backend.pathState(),
  poolSnapshot: (backend) => backend.poolSnapshot(),
  edgeEvidenceList: (backend) => backend.edgeEvidenceList(),
  entitiesSnapshot: (backend) => backend.entitiesSnapshot(),
};

function ReadCard({
  title,
  icon: Icon,
  rows,
}: {
  title: string;
  icon: typeof Activity;
  rows: SummaryRow[];
}) {
  return (
    <div className="ink-elevated p-3" data-ui="mechanism_read_card">
      <div className="flex items-center gap-2 text-[12px] font-medium">
        <Icon size={13} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span>{title}</span>
      </div>
      <div className="mt-2 space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-2 text-[11px]" data-tone={row.tone}>
            <span className="shrink-0 ink-text-faint">{row.label}</span>
            <span className="ml-auto font-mono tabular-nums ink-text-muted">{row.value}</span>
          </div>
        ))}
        {rows.every((row) => row.tone === 'empty') && rows[0]?.detail ? (
          <p className="text-[10px] leading-relaxed ink-text-faint">{rows[0].detail}</p>
        ) : null}
      </div>
    </div>
  );
}

/** 机制监控视图主体：并行读取七面，逐面独立渲染。 */
export function MechanismView({ backend }: MechanismViewProps): JSX.Element {
  const [results, setResults] = useState<Record<string, SummaryRow[]>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!backend?.available) {
      setResults({});
      setLoaded(true);
      return undefined;
    }
    setLoaded(false);
    const next: Record<string, SummaryRow[]> = {};
    void Promise.all(
      READ_META.map(async (meta) => {
        let raw: unknown = null;
        try {
          raw = await READ_METHODS[meta.method](backend);
        } catch {
          raw = null;
        }
        if (!cancelled) next[meta.key] = mapRead(meta.key, raw);
      }),
    ).then(() => {
      if (cancelled) return;
      setResults(next);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [backend]);

  if (!backend?.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-[12px] ink-text-faint" data-ui="mechanism_view">
        <p>机制监控仅在宿主运行时可用</p>
        <p className="text-[11px]">metrics / assemble / cache / path / pool / edge / entities 读取面空态可观测</p>
      </div>
    );
  }

  return (
    <div className="ink-scroll-auto h-full overflow-y-auto px-4 py-5" data-ui="mechanism_view">
      <div className="mx-auto max-w-2xl">
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium">机制监控</span>
          <span className="text-[11px] ink-text-faint">引擎机制读取面只读投影（未装配 = 空态可观测）</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {READ_META.map((meta) => (
            <ReadCard
              key={meta.key}
              title={meta.title}
              icon={meta.icon}
              rows={results[meta.key] ?? (loaded ? mapRead(meta.key, null) : [{ label: '读取中', value: '…', tone: 'empty' }])}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
