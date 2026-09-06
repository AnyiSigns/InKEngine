/**
 * 知识集面板（只读面）：成长状态头（growth.report）+ 知识条目只读列表。
 *
 * W1 命令面收敛：知识写操作（add/promote/archive/restore/skill_import）
 * 无真源不提供——本面板只保留读面（knowledge.list 条目窗口 +
 * knowledge.export JSON 导出）；条目行不提供写按钮，统一标注只读。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Download, RefreshCw, Search, Sparkles } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { TextInput } from '@/shared/ui/Field';
import { createBackend } from '@/shared/backend/backendAdapter';
import { logger } from '@/shared/logger';
import {
  compareCredibility,
  createKnowledgeOps,
  credibilityClass,
  credibilityLabel,
  credibilityLevel,
  type KnowledgeData,
  type KnowledgeEntry,
} from './backend';

interface GrowthReportView {
  enabled?: boolean;
  config_summary?: Record<string, unknown> | null;
  weights_snapshot?: Record<string, unknown> | null;
  last_tuned_at?: number | null;
}

const KIND_LABELS: Record<string, string> = {
  rule: '规则',
  template: '模板',
  insight: '洞见',
  weight: '权重',
  tool_rule: '工具规则',
  path: '技能',
  script: '脚本',
};

const KIND_FILTERS = ['', 'rule', 'template', 'insight', 'path', 'script', 'weight', 'tool_rule'] as const;

function fmtTs(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function KnowledgePanel(): JSX.Element {
  const backendRef = useRef(createBackend());
  const opsRef = useRef(createKnowledgeOps());
  const [data, setData] = useState<KnowledgeData | null>(null);
  const [growth, setGrowth] = useState<GrowthReportView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'empty' | 'unavailable' | 'error'>('loading');
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [exportPhase, setExportPhase] = useState<'idle' | 'loading' | 'done'>('idle');

  const load = async () => {
    setLoadState('loading');
    if (!backendRef.current.available) {
      setData(null);
      setGrowth(null);
      setLoadState('unavailable');
      return;
    }
    try {
      const result = await opsRef.current.list(true);
      setData(result);
      setLoadState(result.entries.length > 0 ? 'ready' : 'empty');
    } catch (err) {
      logger.error('knowledge', '知识集读取失败', { err: String(err) });
      setLoadState('error');
    }
  };

  const loadGrowth = async () => {
    if (!backendRef.current.available) {
      setGrowth(null);
      return;
    }
    try {
      const result = await backendRef.current.growthReport();
      setGrowth({
        enabled: result?.enabled ?? false,
        config_summary: result?.config_summary ?? null,
        weights_snapshot: result?.weights_snapshot ?? null,
        last_tuned_at: result?.last_tuned_at ?? null,
      });
    } catch {
      setGrowth(null);
    }
  };

  useEffect(() => {
    void load();
    void loadGrowth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allEntries = data?.entries ?? [];
  const activeEntries = allEntries.filter((e) => (showArchived ? true : !e.archived));
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of activeEntries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return counts;
  }, [activeEntries]);

  const searchLower = search.toLowerCase();
  const filtered = activeEntries
    .filter((e) => !kindFilter || e.kind === kindFilter)
    .filter((e) =>
      e.title.toLowerCase().includes(searchLower) ||
      e.content.toLowerCase().includes(searchLower) ||
      e.tags.some((t) => t.toLowerCase().includes(searchLower)),
    )
    .sort(compareCredibility);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExport = async (): Promise<void> => {
    if (exportPhase === 'loading') return;
    setExportPhase('loading');
    const json = await opsRef.current.exportJson();
    setExportPhase('done');
    if (json === null) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `knowledge_export_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const weightsKeys = growth?.weights_snapshot ? Object.keys(growth.weights_snapshot) : [];
  const configSummary = growth?.config_summary ?? null;

  return (
    <div data-ui="knowledge_panel" className="flex flex-col gap-3">
      {/* ── 状态头：成长状态（growth.report 只读）── */}
      <div className="ink-elevated space-y-2 px-3.5 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] ink-text-faint">自学习管线（growth.report · 只读）</span>
          <span
            className="ink-chip"
            data-ui="growth_enabled"
            data-active={growth?.enabled ?? true}
          >
            {growth === null ? '宿主不可用' : growth.enabled ? '默认开启' : '停用'}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="text-[9px] ink-text-faint">reuse_first</div>
            <div className="text-[var(--ink-font-md)] font-semibold">
              {configSummary && typeof configSummary['reuse_first'] === 'boolean'
                ? (configSummary['reuse_first'] as boolean) ? '开启' : '关闭'
                : '—'}
            </div>
          </div>
          <div data-ui="growth_weights">
            <div className="text-[9px] ink-text-faint">权重条目</div>
            <div className="text-[var(--ink-font-md)] font-semibold">{weightsKeys.length}</div>
          </div>
          <div>
            <div className="text-[9px] ink-text-faint">最近调参</div>
            <div className="text-[var(--ink-font-md)] font-semibold">{fmtTs(growth?.last_tuned_at)}</div>
          </div>
        </div>
        <p className="text-[9px] ink-text-faint" data-ui="growth_flush_note">
          {weightsKeys.length > 0
            ? `权重键：${weightsKeys.slice(0, 6).join('、')}${weightsKeys.length > 6 ? ` 等 ${weightsKeys.length} 个` : ''}`
            : '无权重快照（知识集无 kind=weight 条目或引擎未装配）'}
        </p>
      </div>

      {/* ── 工具行 ── */}
      <div className="flex items-center gap-2">
        <BookOpen size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" aria-hidden />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">知识集</h3>
        <span className="ink-chip py-px text-[9px] ink-text-faint">只读</span>
        <div className="flex-1" />
        <Button size="xs" variant="secondary" onClick={() => void handleExport()} disabled={exportPhase === 'loading'}>
          <Download size={10} strokeWidth={1.6} aria-hidden />
          {exportPhase === 'loading' ? '导出中…' : '导出 JSON'}
        </Button>
      </div>

      {loadState === 'unavailable' && (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          宿主不可用——知识集仅在宿主运行时可用
        </div>
      )}
      {loadState === 'error' && (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          知识集读取失败
          <button type="button" className="ink-link ml-2 text-[11px]" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {loadState === 'empty' && (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          知识集为空
        </div>
      )}
      {loadState === 'ready' && (
        <>
          {/* ── kind 筛选 + 搜索 ── */}
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {KIND_FILTERS.map((kind) => (
                <button
                  key={kind || 'all'}
                  type="button"
                  data-ui={`kind_filter_${kind || 'all'}`}
                  onClick={() => setKindFilter(kind)}
                  className={`rounded-md px-2 py-1 text-[10px] ${
                    kindFilter === kind
                      ? 'bg-[var(--ink-accent)] text-white'
                      : 'ink-text-muted hover:bg-[var(--ink-bg-elevated)]'
                  }`}
                >
                  {kind ? `${KIND_LABELS[kind] ?? kind} ${kindCounts[kind] ?? 0}` : `全部 ${activeEntries.length}`}
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-32">
              <Search size={12} strokeWidth={1.6} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-text-faint)]" aria-hidden />
              <TextInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索知识..."
                className="pl-6"
              />
            </div>
            <Button size="xs" variant="ghost" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? '隐藏归档' : '显示归档'}
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {filtered.map((entry) => (
              <KnowledgeRow
                key={entry.id}
                entry={entry}
                expanded={expanded.has(entry.id)}
                onToggle={() => toggleExpand(entry.id)}
              />
            ))}
            {filtered.length === 0 && (
              <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-6 text-center text-[11px] text-[var(--ink-text-faint)]">
                无匹配条目
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex items-center justify-between px-1">
        <p className="text-[9px] ink-text-faint">知识集只读（写操作由机制自进化通道维护，不提供用户写面）</p>
        <button
          type="button"
          onClick={() => { void load(); void loadGrowth(); }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] ink-text-muted hover:bg-[var(--ink-bg-elevated)] cursor-pointer bg-transparent border-none"
          data-ui="knowledge_refresh"
        >
          <RefreshCw size={10} strokeWidth={1.6} aria-hidden /> 刷新
        </button>
      </div>
    </div>
  );
}

interface KnowledgeRowProps {
  entry: KnowledgeEntry;
  expanded: boolean;
  onToggle: () => void;
}

function KnowledgeRow({ entry, expanded, onToggle }: KnowledgeRowProps): JSX.Element {
  const level = credibilityLevel(entry.credibility);
  return (
    <div
      data-ui={`knowledge_entry_${entry.id}`}
      data-archived={entry.archived}
      className="flex flex-col gap-1 rounded border border-[var(--ink-border)] p-2"
    >
      <div className="flex items-center gap-2">
        <button type="button" onClick={onToggle} className="cursor-pointer" aria-label="展开">
          <Sparkles size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </button>
        <span className="ink-chip">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
        <span className="truncate text-[11px] font-medium text-[var(--ink-text-base)]">{entry.title}</span>
        <span className={`text-[9px] ${credibilityClass(level)}`}>
          {credibilityLabel(level)} ({entry.credibility.toFixed(2)})
        </span>
        {entry.archived && (
          <span className="rounded border border-[var(--ink-border)] px-1 py-0.5 text-[9px] text-[var(--ink-text-faint)]">
            已归档
          </span>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-1 pl-5">
          <div className="text-[11px] text-[var(--ink-text-muted)] whitespace-pre-wrap">{entry.content}</div>
          <div className="flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <span key={tag} className="rounded border border-[var(--ink-border)] px-1 py-0.5 text-[9px] text-[var(--ink-text-faint)]">
                {tag}
              </span>
            ))}
          </div>
          {entry.usage_failures.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              <div className="text-[10px] font-medium text-[var(--ink-text-muted)]">失败记录</div>
              {entry.usage_failures.map((f, i) => (
                <div key={i} className="text-[10px] text-[var(--ink-text-faint)]">
                  {f.reason}
                </div>
              ))}
            </div>
          )}
          <div className="text-[9px] ink-text-faint">
            {entry.source || '—'} · 级别 {entry.level} · 更新 {fmtTs(entry.updated_at)}
          </div>
        </div>
      )}
    </div>
  );
}
