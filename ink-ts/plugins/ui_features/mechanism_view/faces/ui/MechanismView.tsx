/**
 * 状态页机制读取面（分层卡）：引擎机制读口只读投影重组为
 * ① 回合概览 + ② 边证据与实体（观察面）。
 *
 * 数据 = host 已接读取面：metrics.snapshot / edge_evidence.list /
 * entities.snapshot。available=false（机制未装配）或读取失败 =
 * 结构化空态文案，不报错不白屏。宿主不可用 = 整页空态。
 * 组装链读面（pool.snapshot / assemble.stats / path.state / cache.stats）
 * 已随组装链路退役（W7-B）。
 */

import { useEffect, useState } from 'react';
import { Activity, GitMerge, Users } from 'lucide-react';

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

interface MetricRow {
  label: string;
  value: string;
  tone: 'ok' | 'empty';
  detail?: string;
}

interface MetricGroup {
  caption?: string;
  rows: MetricRow[];
}

const emptyRow = (note: string): MetricRow => ({ label: '未装配', value: '—', tone: 'empty', detail: note });

const LOADING_GROUP: MetricGroup[] = [{ rows: [{ label: '读取中', value: '…', tone: 'empty' }] }];

/** metrics.snapshot 里的自动续跑轮独立计数（组装自续轮口径；主线执行不经此计数）。 */
function autoRounds(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  for (const key of ['auto_rounds', 'auto_turns', 'auto'] as const) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** ① 回合概览：回合/自动续跑轮/失败/失败率（metrics.snapshot 只读投影）。 */
function overviewGroups(raw: unknown): MetricGroup[] {
  const snap = asRecord(raw);
  if (!snap || snap['available'] !== true) return [{ rows: [emptyRow('metrics.snapshot 无装配')] }];
  const auto = autoRounds(snap);
  return [
    {
      caption: '口径：回合数 = 引擎顶层回合计数（主线执行不经该通道）',
      rows: [
        { label: '回合', value: String(num(snap['rounds'])), tone: 'ok' },
        { label: '自动续跑轮', value: auto === null ? '—' : String(auto), tone: auto === null ? 'empty' : 'ok' },
        { label: '失败', value: String(num(snap['failures'])), tone: 'ok' },
        { label: '失败率', value: num(snap['avg']).toFixed(3), tone: 'ok' },
      ],
    },
  ];
}

/** ② 边证据卡：策略边/成功失败计数（edge_evidence.list 只读投影）。 */
function edgeGroups(raw: unknown): MetricGroup[] {
  const snap = asRecord(raw);
  if (!snap || snap['available'] !== true) {
    return [{ rows: [emptyRow('edge_evidence.list 无装配')] }];
  }
  const edges = Array.isArray(snap['edges']) ? (snap['edges'] as unknown[]) : [];
  const policy = edges.filter((edge) => asRecord(edge)?.['policy'] === true).length;
  return [
    {
      rows: [
        { label: '边数', value: String(edges.length), tone: 'ok' },
        { label: '策略边', value: String(policy), tone: 'ok' },
      ],
    },
  ];
}

/** ③ 实体卡：协作者注册目录统计（entities.snapshot 只读投影）。 */
function entityGroups(raw: unknown): MetricGroup[] {
  const entSnap = asRecord(raw);
  if (!entSnap) {
    return [{ rows: [emptyRow('entities.snapshot 无装配')] }];
  }
  if (entSnap['available'] !== true || entSnap['degraded'] === true) {
    return [{ rows: [emptyRow('实体注册表未装配（degraded）')] }];
  }
  const max = entSnap['max'];
  return [
    {
      rows: [
        { label: '实体', value: String(num(entSnap['count'])), tone: 'ok' },
        { label: '配额', value: typeof max === 'number' ? String(max) : '—', tone: 'ok' },
      ],
    },
  ];
}

const READ_META = [
  { key: 'metrics', method: 'metricsSnapshot' as const },
  { key: 'edge', method: 'edgeEvidenceList' as const },
  { key: 'entities', method: 'entitiesSnapshot' as const },
];

const READ_METHODS: Record<string, (backend: BackendAdapter) => Promise<unknown>> = {
  metricsSnapshot: (backend) => backend.metricsSnapshot(),
  edgeEvidenceList: (backend) => backend.edgeEvidenceList(),
  entitiesSnapshot: (backend) => backend.entitiesSnapshot(),
};

function MetricCard({
  title,
  icon: Icon,
  groups,
}: {
  title: string;
  icon: typeof Activity;
  groups: MetricGroup[];
}) {
  return (
    <section className="ink-elevated p-3" data-ui="mechanism_card" data-card={title}>
      <header className="flex items-center gap-2 text-[12px] font-medium">
        <Icon size={13} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span>{title}</span>
      </header>
      {groups.map((group, index) => (
        <div key={group.caption ?? index} className="mt-2">
          {group.caption !== undefined && <div className="text-[10px] tracking-wide ink-text-faint">{group.caption}</div>}
          {group.rows.every((row) => row.tone === 'empty') && group.rows[0]?.detail ? (
            <p className="text-[10px] leading-relaxed ink-text-faint">{group.rows[0].detail}</p>
          ) : (
            <div className="space-y-1">
              {group.rows.map((row) => (
                <div key={row.label} className="flex items-baseline gap-2 text-[11px]" data-tone={row.tone}>
                  <span className="shrink-0 ink-text-faint">{row.label}</span>
                  <span className="ml-auto font-mono tabular-nums ink-text-muted">{row.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

/** 状态页机制读取面主体：并行读取读面，分层渲染（概览/边证据/实体）。 */
export function MechanismView({ backend }: MechanismViewProps): JSX.Element {
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!backend?.available) {
      setResults({});
      setLoaded(true);
      return undefined;
    }
    setLoaded(false);
    const next: Record<string, unknown> = {};
    void Promise.all(
      READ_META.map(async (meta) => {
        let raw: unknown = null;
        try {
          raw = await READ_METHODS[meta.method](backend);
        } catch {
          raw = null;
        }
        if (!cancelled) next[meta.key] = raw;
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
        <p>状态读取面仅在宿主运行时可用</p>
        <p className="text-[11px]">回合概览 / 边证据 / 实体读取面空态可观测</p>
      </div>
    );
  }

  const loading = !loaded;
  return (
    <div className="px-4 py-5" data-ui="mechanism_view">
      <div className="mx-auto max-w-2xl">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MetricCard
            title="回合概览"
            icon={Activity}
            groups={loading ? LOADING_GROUP : overviewGroups(results['metrics'])}
          />
          <MetricCard
            title="边证据"
            icon={GitMerge}
            groups={loading ? LOADING_GROUP : edgeGroups(results['edge'])}
          />
          <MetricCard
            title="实体"
            icon={Users}
            groups={loading ? LOADING_GROUP : entityGroups(results['entities'])}
          />
        </div>
      </div>
    </div>
  );
}