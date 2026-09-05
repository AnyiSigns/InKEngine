/**
 * 账本页（主区「账本」页签）：回合账本事实快照流 + 摘要链区。
 *
 * 数据 = 宿主后端读取（round_ledger_list 账本清单 / round_ledger_chain
 * 摘要链）：每回合收尾自动落一条账本（意图/结论/事实要点，零模型成本），
 * 摘要链为跨回合压缩的阶段性小结（round_ledger_merge 手动触发）。
 * 宿主不可用 = 空态提示；切线程自动刷新。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, FileClock, Loader2, RefreshCw, Shrink } from 'lucide-react';

import type { BackendAdapter, RoundLedgerItem } from '@/shared/backend/backendAdapter';

interface LedgerViewProps {
  backend: BackendAdapter;
  threadId: string;
}

function formatTime(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function eventLabel(kind: string): string {
  switch (kind) {
    case 'tool_start':
      return '工具调用';
    case 'tool_end':
      return '工具完成';
    case 'plan_start':
      return '计划开始';
    case 'spawn_start':
      return '派生开始';
    case 'error':
      return '错误';
    default:
      return kind;
  }
}

export function LedgerView({ backend, threadId }: LedgerViewProps): JSX.Element {
  const [ledgers, setLedgers] = useState<RoundLedgerItem[] | null>(null);
  const [chain, setChain] = useState<string[] | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');
  const [mergePhase, setMergePhase] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');
  const mergeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (mergeTimer.current) clearTimeout(mergeTimer.current);
  }, []);

  const load = useCallback(() => {
    if (!backend.available || !threadId) {
      setLedgers(null);
      setChain(null);
      return;
    }
    setPhase('loading');
    void Promise.all([
      backend.roundLedgerList(threadId).then((r) => setLedgers(r.ledgers ?? [])),
      backend.roundLedgerChain(threadId).then((r) => setChain(r.chain ?? [])),
    ])
      .then(() => setPhase('success'))
      .catch(() => setPhase('fail'));
  }, [backend, threadId]);

  useEffect(() => {
    setLedgers(null);
    setChain(null);
    load();
  }, [load]);

  const runMerge = () => {
    if (!backend.available || !threadId) return;
    setMergePhase('loading');
    void backend
      .roundLedgerMerge(threadId)
      .then(() => {
        setMergePhase('success');
        if (mergeTimer.current) clearTimeout(mergeTimer.current);
        mergeTimer.current = setTimeout(() => setMergePhase('idle'), 1500);
        load();
      })
      .catch(() => {
        setMergePhase('fail');
        if (mergeTimer.current) clearTimeout(mergeTimer.current);
        mergeTimer.current = setTimeout(() => setMergePhase('idle'), 2000);
      });
  };

  const eventCount = (ledgers ?? []).reduce((acc, l) => acc + (l.events?.length ?? 0), 0);
  const summaryCount = chain?.length ?? 0;

  if (!backend.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-[12px] ink-text-faint">
        <p>账本仅在宿主运行时可用</p>
        <p className="text-[11px]">请经桌面壳启动后查看回合事实快照</p>
      </div>
    );
  }

  if (phase === 'fail') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] ink-text-faint">
        <p>账本读取失败</p>
        <button type="button" className="ink-link text-[11px]" onClick={load}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="ink-scroll-auto flex-1 overflow-y-auto px-4 py-5">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 flex items-baseline gap-3">
          <span className="text-[13px] font-medium">回合账本</span>
          <span className="text-[11px] ink-text-faint">
            {ledgers === null ? '读取中…' : `${ledgers.length} 条回合快照${eventCount > 0 ? ` · ${eventCount} 条事实要点` : ''}`}
          </span>
          <button
            type="button"
            className="ml-auto flex items-center gap-1 text-[11px] ink-text-muted hover:opacity-80"
            onClick={load}
            data-ui="ledger_refresh"
          >
            <RefreshCw size={11} strokeWidth={1.6} /> 刷新
          </button>
        </div>

        {ledgers === null ? (
          <div className="flex items-center gap-2 text-[11px] ink-text-faint">
            <Loader2 size={12} strokeWidth={1.6} className="animate-spin" /> 读取账本…
          </div>
        ) : ledgers.length === 0 ? (
          <div className="rounded-lg border ink-border px-4 py-6 text-center text-[11px] ink-text-faint">
            暂无账本 —— 会话运行一回合后，这里会展示该回合确认的意图/结论与事实快照
          </div>
        ) : (
          <ol className="relative space-y-1 border-l ink-border pl-5">
            {ledgers.map((l) => (
              <li key={l.round_id} className="relative flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-[var(--ink-bg-surface)]">
                <span className="absolute -left-[26px] top-2.5 flex h-4 w-4 items-center justify-center bg-[var(--ink-bg-base)]">
                  <FileClock size={13} strokeWidth={1.6} className="ink-text-muted" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px]">{l.intent || '回合'}</span>
                    <span className="shrink-0 text-[11px] ink-text-faint">{formatTime(l.created_at)}</span>
                    {(l.events?.length ?? 0) > 0 && (
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] ink-text-faint">{l.events?.length} 条要点</span>
                    )}
                  </div>
                  {l.conclusion && <p className="mt-0.5 text-[11px] leading-relaxed ink-text-muted">{l.conclusion}</p>}
                  {(l.events ?? []).slice(0, 5).map((e, i) => (
                    <p key={`${e.at}-${i}`} className="mt-0.5 truncate font-mono text-[10px] ink-text-faint">
                      {eventLabel(e.kind)}
                      {typeof e.detail === 'object' && e.detail && Object.keys(e.detail).length > 0
                        ? ` · ${String(Object.values(e.detail).find((v) => typeof v === 'string') ?? '')}`
                        : ''}
                    </p>
                  ))}
                  {(l.events?.length ?? 0) > 5 && (
                    <p className="mt-0.5 text-[10px] ink-text-faint">… 其余 {(l.events?.length ?? 0) - 5} 条省略</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        <div className="mb-2 mt-6 flex items-baseline gap-3">
          <span className="text-[13px] font-medium">摘要链</span>
          <span className="text-[11px] ink-text-faint">
            {chain === null ? '读取中…' : `${summaryCount} 条阶段性小结`}
          </span>
          <button
            type="button"
            className="ml-auto flex items-center gap-1 text-[11px] ink-text-muted hover:opacity-80"
            onClick={runMerge}
            disabled={mergePhase === 'loading'}
            data-ui="ledger_merge"
          >
            <Shrink size={11} strokeWidth={1.6} />
            {mergePhase === 'loading' ? '压缩中…' : '压缩摘要链'}
          </button>
        </div>
        {chain === null ? (
          <div className="flex items-center gap-2 text-[11px] ink-text-faint">
            <Loader2 size={12} strokeWidth={1.6} className="animate-spin" /> 读取摘要链…
          </div>
        ) : chain.length === 0 ? (
          <div className="rounded-lg border ink-border px-4 py-4 text-center text-[11px] ink-text-faint">
            暂无阶段小结 —— 点击「压缩摘要链」把账本事实快照压缩成一条摘要
          </div>
        ) : (
          <ol className="space-y-1.5">
            {chain.map((summary, i) => (
              <li key={`${i}-${summary.length}`} className="rounded-lg border ink-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <BookOpen size={12} strokeWidth={1.6} className="shrink-0 ink-text-muted" />
                  <span className="truncate text-[11px] leading-relaxed ink-text-muted">{summary}</span>
                </div>
              </li>
            ))}
          </ol>
        )}

        {mergePhase === 'success' && <p className="mt-2 text-[11px] ink-text-muted">摘要链已压缩</p>}
        {mergePhase === 'fail' && <p className="mt-2 text-[11px] ink-accent">压缩失败（引擎未就绪或账本为空）</p>}
      </div>
    </div>
  );
}
