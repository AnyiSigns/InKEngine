/**
 * 账本页（主区「账本」页签）：回合账本事实流（records.ledger 只读窗口）。
 *
 * 数据 = 宿主后端读取（round_ledger_list → records.ledger）：每回合收尾
 * 自动落一条账本记录，由引擎投影为事实行（kind/action/node_id/detail/ts，
 * 时间倒序）。round_ledger_merge 无真源不提供（web 不展示摘要链压缩入口）；
 * 宿主不可用 = 空态提示；切线程自动刷新。
 */

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, FileClock, Loader2, RefreshCw } from 'lucide-react';

import type { BackendAdapter, RoundLedgerEntry } from '@/shared/backend/backendAdapter';

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

/** 事实行标签（kind 优先；未知回落原始 kind）。 */
function factTitle(entry: RoundLedgerEntry): string {
  const detailText =
    entry.detail && typeof entry.detail['text'] === 'string' && entry.detail['text'] !== ''
      ? entry.detail['text']
      : '';
  switch (entry.kind) {
    case 'intent':
      return `意图：${detailText || '（无文本）'}`;
    case 'conclusion':
      return `结论：${detailText || '（无文本）'}`;
    case 'error':
      return `错误：${detailText || entry.action}`;
    case 'tool_start':
      return detailText ? `工具调用：${detailText}` : `工具调用（${entry.action}）`;
    case 'tool_end':
      return detailText ? `工具完成：${detailText}` : `工具完成（${entry.action}）`;
    default:
      return detailText ? `${entry.kind}：${detailText}` : `${entry.kind}（${entry.action}）`;
  }
}

export function LedgerView({ backend, threadId }: LedgerViewProps): JSX.Element {
  const [ledgers, setLedgers] = useState<RoundLedgerEntry[] | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');

  const load = useCallback(() => {
    if (!backend.available || !threadId) {
      setLedgers(null);
      setPhase('success');
      return;
    }
    setPhase('loading');
    backend
      .roundLedgerList(threadId)
      .then((r) => {
        setLedgers(r.entries ?? []);
        setPhase('success');
      })
      .catch(() => setPhase('fail'));
  }, [backend, threadId]);

  useEffect(() => {
    setLedgers(null);
    load();
  }, [load]);

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
            {ledgers === null ? '读取中…' : `${ledgers.length} 条事实快照`}
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
          <ol className="space-y-1">
            {ledgers.map((entry, i) => (
              <li
                key={`${entry.node_id ?? entry.kind}-${entry.ts}-${i}`}
                className="flex items-start gap-2.5 rounded-lg border ink-border px-3 py-2"
              >
                <FileClock size={13} strokeWidth={1.6} className="mt-0.5 shrink-0 ink-text-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[12px]">{factTitle(entry)}</span>
                    <span className="ml-auto shrink-0 text-[10px] ink-text-faint">{formatTime(entry.ts)}</span>
                  </div>
                  {entry.node_id ? (
                    <p className="mt-0.5 font-mono text-[9px] ink-text-faint">节点 {entry.node_id}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-5 rounded-lg border border-dashed ink-border px-3 py-3 text-[10px] leading-relaxed ink-text-faint">
          <BookOpen size={10} strokeWidth={1.6} className="mr-1 inline" aria-hidden />
          账本只读展示引擎确定性归约的事实要点（意图/结论/事件留痕）；阶段小结压缩由引擎侧回合收尾维护。
        </div>
      </div>
    </div>
  );
}
