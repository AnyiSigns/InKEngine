import { X } from 'lucide-react';

import type { TaskCapsuleData } from './types';

interface TaskCapsuleProps {
  task: TaskCapsuleData;
  onCancel?: () => void;
  onOpen?: () => void;
}

export function TaskCapsule({ task, onCancel, onOpen }: TaskCapsuleProps) {
  const progress = task.total > 0 ? Math.round((task.step / task.total) * 100) : 0;

  return (
    <div
      data-ui="task_capsule"
      data-status={task.status}
      className="flex items-center gap-2 rounded border border-[var(--ink-border)] px-2 py-1.5 cursor-pointer"
      onClick={onOpen}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-[var(--ink-text-base)]">
          任务 · 步骤 {task.step}/{task.total}
        </div>
        <div className="mt-1 h-1 w-full rounded-full bg-[var(--ink-bg-elevated)]">
          <div
            className="h-full rounded-full bg-[var(--ink-text-muted)] transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      {task.status === 'running' && onCancel && (
        <button
          type="button"
          data-ui="task_capsule_cancel"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
          className="shrink-0 rounded p-0.5 text-[var(--ink-text-faint)] hover:text-[var(--ink-text-base)] cursor-pointer"
        >
          <X size={12} strokeWidth={1.6} />
        </button>
      )}
    </div>
  );
}

export function TaskCapsuleSpec() {
  return (
    <div data-ui="task_capsule_spec" className="rounded border border-dashed border-[var(--ink-border)] p-3 text-[11px] text-[var(--ink-text-faint)]">
      任务胶囊规格：仅长任务期间存在，状态/进度/取消，点开→管理台任务节
    </div>
  );
}
