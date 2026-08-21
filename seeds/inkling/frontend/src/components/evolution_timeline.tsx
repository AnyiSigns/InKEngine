/**
 * 演化时间线（演化视图）：补丁链可视化。
 *
 * 数据源：inspect_graph 快照的 patchChain（bind.path = "patchChain"，
 * 五元工具快照投影）。状态色：proposed=待审/applied=已应用/reverted=已回退
 * （回退可逆——补丁链尾部回退是演化安全网）。
 *
 * 纯渲染组件：数据 props 注入，无写入通道。
 */

import { History, RotateCcw } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { PatchChainEntry } from '@/shared/session/types';

interface EvolutionTimelineProps {
  bindValue?: unknown;
}

const STATUS_LABELS: Record<PatchChainEntry['status'], string> = {
  proposed: '待审',
  applied: '已应用',
  reverted: '已回退',
};

function statusTone(status: PatchChainEntry['status']): string {
  if (status === 'reverted') return 'ink-accent-bg ink-accent';
  if (status === 'proposed') return 'ink-text-faint';
  return 'ink-panel';
}

export function EvolutionTimeline({ bindValue }: EvolutionTimelineProps) {
  const chain = (bindValue as PatchChainEntry[] | undefined) ?? [];

  return (
    <section className="ink-panel rounded-md p-3">
      <div className="flex items-center gap-1.5">
        <History size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        <span className="text-[11px] font-medium">演化时间线</span>
        <span className="ml-auto text-[10px] ink-text-faint">补丁链（可回退）</span>
      </div>

      {chain.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed px-3 py-4 text-center text-[11px] ink-border ink-text-faint">
          补丁链为空（变化经 propose_patch → 分级审批 → append 沉淀于此）
        </div>
      ) : (
        <ol className="mt-2 space-y-1.5">
          {chain.map((entry, index) => (
            <li key={entry.patchId} className="relative flex items-start gap-2 pl-4">
              {index < chain.length - 1 && (
                <span className="absolute left-[5px] top-3 h-[calc(100%-8px)] w-px bg-[var(--ink-border)]" aria-hidden />
              )}
              <span
                className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full border"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[11px]">{entry.title}</span>
                  <span className="rounded bg-[var(--ink-bg-elevated)] px-1 py-px text-[9px] font-mono ink-text-faint">
                    {entry.kind}
                  </span>
                  <span className={cn('ml-auto shrink-0 rounded px-1 py-px text-[9px]', statusTone(entry.status))}>
                    {STATUS_LABELS[entry.status]}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[9px] ink-text-faint">
                  <span className="font-mono">{entry.patchId}</span>
                  {entry.level ? <span>审批档 {entry.level}</span> : null}
                  {entry.appliedAt ? <span>{new Date(entry.appliedAt).toLocaleString()}</span> : null}
                </div>
                {entry.status === 'reverted' && entry.revertReason && (
                  <div className="mt-0.5 flex items-center gap-1 text-[9px] ink-accent">
                    <RotateCcw size={9} strokeWidth={1.6} aria-hidden />
                    {entry.revertReason}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
