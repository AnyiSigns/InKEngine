import type { RoundTaskSummaryData } from './types';

interface RoundTaskSummaryProps {
  data: RoundTaskSummaryData;
}

export function RoundTaskSummary({ data }: RoundTaskSummaryProps) {
  return (
    <div data-ui="round_task_summary" className="flex flex-col gap-2 rounded border border-[var(--ink-border)] p-3">
      <div className="text-[12px] font-medium text-[var(--ink-text-base)]">任务摘要</div>
      <div className="flex flex-col gap-1 text-[11px] text-[var(--ink-text-muted)]">
        <div>
          <span className="text-[var(--ink-text-faint)]">目标：</span>
          {data.goal}
        </div>
        <div>
          <span className="text-[var(--ink-text-faint)]">状态：</span>
          {data.status}
        </div>
        {data.changed_files.length > 0 && (
          <div>
            <span className="text-[var(--ink-text-faint)]">变更文件：</span>
            {data.changed_files.join(', ')}
          </div>
        )}
        <div>
          <span className="text-[var(--ink-text-faint)]">下一步：</span>
          {data.next_step}
        </div>
        <div>
          <span className="text-[var(--ink-text-faint)]">摘要引用：</span>
          {data.summary_ref}
        </div>
      </div>
    </div>
  );
}
