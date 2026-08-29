/**
 * 来源明细：检索/记忆/证据留痕溯源。
 *
 * 数据源：state.sourceTraces 通道（memory_recall / vetting_result / tuning_update /
 * device_* 事件落位）。知识条目可跳到知识集（knowledgeId 留痕，供检索注入跳转）。
 *
 * 纯渲染组件：数据 props 注入，无写入通道。
 */

import { Database, FileSearch, Fingerprint, Monitor } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { SourceTraceEntry } from '@/shared/session/types';

interface SourceTraceProps {
  bindValue?: unknown;
}

const SOURCE_META: Record<SourceTraceEntry['sourceType'], { label: string; icon: typeof Database }> = {
  retrieval: { label: '检索', icon: FileSearch },
  memory: { label: '记忆', icon: Database },
  evidence: { label: '证据', icon: Fingerprint },
  device: { label: '设备', icon: Monitor },
};

export function SourceTrace({ bindValue }: SourceTraceProps) {
  const traces = (bindValue as SourceTraceEntry[] | undefined) ?? [];

  return (
    <section className="ink-panel p-4">
      <div className="flex items-center gap-2.5">
        <span className="ink-icon-chip">
          <Fingerprint size={12} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
        </span>
        <span className="text-[12px] font-semibold tracking-tight">来源明细</span>
        <span className="ml-auto text-[10px] ink-text-faint">依据链溯源（检索/记忆/证据）</span>
      </div>

      {traces.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed px-3 py-5 text-center text-[11px] leading-relaxed ink-border ink-text-faint">
          暂无来源留痕（回合中的检索/记忆召回/证据校验在此留痕）
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {traces.map((trace) => {
            const meta = SOURCE_META[trace.sourceType] ?? SOURCE_META.retrieval;
            const Icon = meta.icon;
            return (
              <li key={trace.id} className="ink-elevated px-3.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Icon size={11} strokeWidth={1.6} className="shrink-0 ink-text-faint" aria-hidden />
                  <span className={cn('rounded-md px-1.5 py-px text-[9px]', 'ink-text-faint')}>{meta.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px]">{trace.title}</span>
                  <span className="shrink-0 text-[9px] ink-text-faint">
                    {new Date(trace.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                {trace.detail && <div className="mt-1 truncate text-[10px] leading-relaxed ink-text-muted">{trace.detail}</div>}
                {trace.knowledgeId && (
                  <div className="mt-1 text-[9px] font-mono ink-text-faint">知识条目：{trace.knowledgeId}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
