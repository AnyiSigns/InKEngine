/**
 * 状态页机制读取面（分层卡）：引擎机制读口只读投影重组为
 * ① 回合概览 + ② 结点池（含结点注册目录段）+ ④ 机制装配次级小卡组。
 * ③ 当前回合图组成清单由 evolution_feed 侧呈现（本组件不重复拉图数据）。
 *
 * 数据 = host 已接读取面：metrics.snapshot / pool.snapshot（含 registry
 * 目录段）/ edge_evidence.list / entities.snapshot / assemble.stats /
 * path.state / cache.stats。available=false（机制未装配）或读取失败 =
 * 结构化空态文案，不报错不白屏。宿主不可用 = 整页空态。
 */

import { useEffect, useState } from 'react';
import { Activity, Boxes, Database, Route } from 'lucide-react';

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

/** metrics.snapshot 里的自动续跑轮独立计数（引擎 turn_metrics 前缀记账批落地前为缺省；数字 0 也算已带）。 */
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
      caption:
        auto === null
          ? '口径：回合数含自续链轮（auto:*）；自动续跑轮独立计数待 metrics 快照字段（auto_rounds/auto_turns）'
          : '口径：回合数含自续链轮（auto:*）；自动续跑轮 = 独立计数（随 metrics 快照）',
      rows: [
        { label: '回合', value: String(num(snap['rounds'])), tone: 'ok' },
        { label: '自动续跑轮', value: auto === null ? '—' : String(auto), tone: auto === null ? 'empty' : 'ok' },
        { label: '失败', value: String(num(snap['failures'])), tone: 'ok' },
        { label: '失败率', value: num(snap['avg']).toFixed(3), tone: 'ok' },
      ],
    },
  ];
}

/** ② 结点池卡：结点注册目录（registry）+ 治理 + 边证据 + 实体，单卡四组。 */
function poolCardGroups(poolRaw: unknown, edgeRaw: unknown, entitiesRaw: unknown): MetricGroup[] {
  const groups: MetricGroup[] = [];
  const snap = asRecord(poolRaw);
  const registry = snap === null ? null : asRecord(snap['registry']);
  if (!registry || registry['available'] !== true) {
    groups.push({ caption: '结点注册', rows: [emptyRow('registry 未装配（runtime.node_registrations 无数据源）')] });
  } else {
    groups.push({
      caption: '结点注册',
      rows: [
        { label: '注册总数', value: String(num(registry['total_count'])), tone: 'ok' },
        { label: '活跃', value: String(num(registry['active_count'])), tone: 'ok' },
      ],
    });
  }
  const counts = snap === null ? null : asRecord(snap['counts']);
  if (!snap || snap['available'] !== true || counts === null) {
    groups.push({ caption: '治理', rows: [emptyRow('pool.snapshot 无装配')] });
  } else {
    groups.push({
      caption: '治理',
      rows: [
        { label: '登记', value: String(num(counts['pool_count'])), tone: 'ok' },
        { label: '判定', value: String(num(counts['evaluations'])), tone: 'ok' },
        { label: '死结点候选', value: String(num(counts['dead_node_candidates'])), tone: 'ok' },
      ],
    });
  }
  const edgeSnap = asRecord(edgeRaw);
  if (!edgeSnap || edgeSnap['available'] !== true) {
    groups.push({ caption: '边证据', rows: [emptyRow('edge_evidence.list 无装配')] });
  } else {
    const edges = Array.isArray(edgeSnap['edges']) ? (edgeSnap['edges'] as unknown[]) : [];
    groups.push({
      caption: '边证据',
      rows: [
        { label: '边数', value: String(edges.length), tone: 'ok' },
        {
          label: '策略边',
          value: String(edges.filter((edge) => asRecord(edge)?.['policy'] === true).length),
          tone: 'ok',
        },
      ],
    });
  }
  const entSnap = asRecord(entitiesRaw);
  if (!entSnap) {
    groups.push({ caption: '实体', rows: [emptyRow('entities.snapshot 无装配')] });
  } else if (entSnap['available'] !== true || entSnap['degraded'] === true) {
    groups.push({ caption: '实体', rows: [emptyRow('实体注册表未装配（degraded）')] });
  } else {
    const max = entSnap['max'];
    groups.push({
      caption: '实体',
      rows: [
        { label: '实体', value: String(num(entSnap['count'])), tone: 'ok' },
        { label: '配额', value: typeof max === 'number' ? String(max) : '—', tone: 'ok' },
      ],
    });
  }
  return groups;
}

/** ④ 组装链小卡：组装器/契约门/canary/最近候选（assemble.stats + path.state 归并）。 */
function assemblyGroups(assembleRaw: unknown, pathRaw: unknown): MetricGroup[] {
  const assemble = asRecord(assembleRaw);
  const path = asRecord(pathRaw);
  const assembleReady = assemble !== null && assemble['available'] === true;
  const pathReady = path !== null && path['available'] === true;
  if (!assembleReady && !pathReady) return [{ rows: [emptyRow('组装链/路径读取面未装配')] }];
  const rows: MetricRow[] = [];
  if (assembleReady) {
    rows.push({ label: '组装器', value: assemble['assembler_enabled'] === true ? '开' : '关', tone: 'ok' });
    rows.push({ label: '契约门', value: assemble['contract_enabled'] === true ? '开' : '关', tone: 'ok' });
    rows.push({ label: 'canary 门', value: assemble['canary_gate'] === true ? '开' : '关', tone: 'ok' });
  } else {
    const enabled = asRecord(path?.['enabled']);
    rows.push({ label: '组装器', value: enabled?.['assembler'] === true ? '开' : '关', tone: 'ok' });
    rows.push({ label: '契约门', value: enabled?.['contract'] === true ? '开' : '关', tone: 'ok' });
    rows.push({ label: 'canary 门', value: path?.['canary_gate'] === true ? '开' : '关', tone: 'ok' });
  }
  if (pathReady) {
    const candidates = asRecord(path['candidates']);
    const count = candidates === null ? null : candidates['last_assembly_count'];
    rows.push({
      label: '最近候选',
      value: count === null || count === undefined ? '—' : String(num(count)),
      tone: 'ok',
    });
  }
  return [{ rows }];
}

/** ④ 指纹缓存小卡：条目/查询/写库（cache.stats 只读投影）。 */
function cacheGroups(raw: unknown): MetricGroup[] {
  const snap = asRecord(raw);
  const cache = snap === null ? null : asRecord(snap['fingerprint_cache']);
  if (!cache || cache['available'] !== true) return [{ rows: [emptyRow('cache.stats 无装配（指纹缓存未挂载）')] }];
  const stats = asRecord(cache['stats']);
  return [
    {
      rows: [
        { label: '条目', value: String(num(cache['entries'])), tone: 'ok' },
        { label: '查询', value: String(num(stats?.['lookups'])), tone: 'ok' },
        { label: '写库', value: String(num(stats?.['upserts'])), tone: 'ok' },
      ],
    },
  ];
}

const READ_META = [
  { key: 'metrics', method: 'metricsSnapshot' as const },
  { key: 'assemble', method: 'assembleStats' as const },
  { key: 'cache', method: 'cacheStats' as const },
  { key: 'path', method: 'pathState' as const },
  { key: 'pool', method: 'poolSnapshot' as const },
  { key: 'edge', method: 'edgeEvidenceList' as const },
  { key: 'entities', method: 'entitiesSnapshot' as const },
];

const READ_METHODS: Record<string, (backend: BackendAdapter) => Promise<unknown>> = {
  metricsSnapshot: (backend) => backend.metricsSnapshot(),
  assembleStats: (backend) => backend.assembleStats(),
  cacheStats: (backend) => backend.cacheStats(),
  pathState: (backend) => backend.pathState(),
  poolSnapshot: (backend) => backend.poolSnapshot(),
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

/** 状态页机制读取面主体：并行读取读面，分层渲染（概览/结点池/机制装配）。 */
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
        <p className="text-[11px]">回合概览 / 结点池 / 机制装配读取面空态可观测</p>
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
            title="结点池"
            icon={Boxes}
            groups={loading ? LOADING_GROUP : poolCardGroups(results['pool'], results['edge'], results['entities'])}
          />
        </div>
        <div className="mb-2 mt-4 flex items-baseline gap-2">
          <span className="text-[13px] font-medium">机制装配</span>
          <span className="text-[11px] ink-text-faint">引擎机制读取面只读投影（未装配 = 空态可观测）</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <MetricCard
            title="组装链"
            icon={Route}
            groups={loading ? LOADING_GROUP : assemblyGroups(results['assemble'], results['path'])}
          />
          <MetricCard title="指纹缓存" icon={Database} groups={loading ? LOADING_GROUP : cacheGroups(results['cache'])} />
        </div>
      </div>
    </div>
  );
}
