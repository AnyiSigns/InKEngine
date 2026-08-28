import { useEffect, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react';

import { invokeOp } from '../../shared/invokeOp';

export interface LedgerEntry {
  round_no: number;
  thread_id: string;
  timestamp: number;
  route_path: string[];
  summary: string;
  cost: number;
  conclusion: string;
}

export interface LedgerChain {
  entries: LedgerEntry[];
}

export function LedgerSection() {
  const [chain, setChain] = useState<LedgerChain | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    void load();
  }, []);

  const load = async () => {
    const result = await invokeOp<LedgerChain>('round_ledger_chain', {});
    setChain(result ?? { entries: [] });
  };

  const toggleExpand = (round: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(round)) next.delete(round);
      else next.add(round);
      return next;
    });
  };

  const entries = chain?.entries ?? [];

  return (
    <div data-ui="ledger_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <BookOpen size={14} strokeWidth={1.6} className="text-[var(--ink-text-muted)]" />
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">账本摘要链</h3>
      </div>

      {entries.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          暂无回合记录
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {entries.map((entry, index) => {
            const isLatest = index === 0;
            return (
              <div
                key={`${entry.round_no}-${entry.thread_id}`}
                data-ui={`ledger_entry_${entry.round_no}`}
                className="flex flex-col gap-1 rounded border border-[var(--ink-border)] p-2"
              >
                <button
                  type="button"
                  onClick={() => toggleExpand(entry.round_no)}
                  className="flex w-full items-center gap-2 cursor-pointer"
                >
                  {expanded.has(entry.round_no) ? (
                    <ChevronDown size={12} strokeWidth={1.6} />
                  ) : (
                    <ChevronRight size={12} strokeWidth={1.6} />
                  )}
                  <span className="text-[11px] font-medium text-[var(--ink-text-base)]">
                    回合 {entry.round_no}
                  </span>
                  <span className="text-[10px] text-[var(--ink-text-faint)]">
                    {new Date(entry.timestamp * 1000).toLocaleString()}
                  </span>
                  {isLatest && (
                    <span className="ml-auto flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--ink-text-muted)] animate-pulse" />
                      <span className="text-[9px] ink-text-faint">最新</span>
                    </span>
                  )}
                </button>

                <div className="pl-5 text-[10px] text-[var(--ink-text-muted)]">
                  <div>路径: {entry.route_path.join(' → ') || '—'}</div>
                  <div>摘要: {entry.summary}</div>
                  <div className="text-[var(--ink-text-faint)]">
                    成本: {entry.cost.toFixed(2)} · 结论: {entry.conclusion}
                  </div>
                </div>

                {expanded.has(entry.round_no) && (
                  <div className="pl-5 mt-1 rounded border border-[var(--ink-border)] p-2 text-[10px] text-[var(--ink-text-muted)]">
                    <div className="font-medium">回合回放</div>
                    <div>线程: {entry.thread_id}</div>
                    <div>完整路径: {entry.route_path.join(' → ')}</div>
                    <div>{entry.summary}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
