/**
 * 规划条目（plan）——与推理同族的蓄力区折叠块：标题为「规划」+ 状态
 * 芯片「规划中」（运行）/「已完成」，workflow 名内联展示。
 */

import { memo } from 'react';

import { ListChecks } from 'lucide-react';

import { cn } from '@/shared/cn';
import type { InkPlanMessage } from '@/shared/session/types';
import { EntryFrame } from './entry_frame';

interface PlanEntryProps {
  message: InkPlanMessage;
  live: boolean;
}

export const PlanEntry = memo(function PlanEntry({ message, live }: PlanEntryProps) {
  const running = message.status === 'running';
  return (
    <EntryFrame
      id={message.id}
      visual="card"
      collapsible
      defaultCollapsed
      header={
        <>
          <span className="ink-icon-chip h-5 w-5">
            <ListChecks size={10} strokeWidth={1.6} className="ink-text-faint" aria-hidden />
          </span>
          <span className="text-[var(--ink-font-xs)] font-medium">规划</span>
          {message.workflow && <span className="font-mono text-[10px] truncate ink-text-faint">{message.workflow}</span>}
          <span className={cn('ink-chip py-px text-[9px]', running ? 'ink-text-muted' : 'ink-text-faint')} data-ui="plan_state">
            {running ? (
              <>
                {live && <span className="ink-live-dot" aria-hidden />}
                规划中
              </>
            ) : (
              '已完成'
            )}
          </span>
        </>
      }
      body={
        <div className="border-t px-3 py-2.5 border-[var(--ink-status-card-edge)] text-[11px] leading-[1.7] whitespace-pre-wrap break-words ink-text-muted">
          {message.content || '（规划中…）'}
        </div>
      }
    />
  );
});
