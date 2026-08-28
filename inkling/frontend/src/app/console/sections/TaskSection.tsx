import { useEffect, useState } from 'react';
import { Ban, RefreshCw } from 'lucide-react';

import { Button } from '@/shared/ui/Button';
import { invokeOp } from '../../shared/invokeOp';

export interface TaskListEntry {
  task_id: string;
  goal: string;
  status: 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';
  progress: number;
  round_no: number;
  changed_files: string[];
  next_step: string;
}

const STATUS_LABELS: Record<TaskListEntry['status'], string> = {
  pending: '待命',
  running: '运行中',
  completed: '完成',
  cancelled: '已取消',
  failed: '失败',
};

export function TaskSection() {
  const [tasks, setTasks] = useState<TaskListEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const result = await invokeOp<{ tasks: TaskListEntry[] }>('task_list', {});
      setTasks(result?.tasks ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleCancel = async (id: string) => {
    await invokeOp('task_cancel', { task_id: id });
    await load();
  };

  const handleRetry = async (id: string) => {
    await invokeOp('task_resume', { task_id: id });
    await load();
  };

  return (
    <div data-ui="task_section" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-medium text-[var(--ink-text-base)]">任务</h3>
        <Button size="xs" variant="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={10} strokeWidth={1.6} />
          刷新
        </Button>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--ink-border)] px-3 py-8 text-center text-[12px] text-[var(--ink-text-faint)]">
          暂无任务
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <div
              key={task.task_id}
              data-ui={`task_entry_${task.task_id}`}
              data-status={task.status}
              className="flex flex-col gap-1 rounded border border-[var(--ink-border)] p-2"
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-[11px] font-medium text-[var(--ink-text-base)]">{task.goal}</span>
                <span className="rounded border border-[var(--ink-border)] px-1 py-0.5 text-[9px] text-[var(--ink-text-faint)]">
                  {STATUS_LABELS[task.status]}
                </span>
                <span className="ml-auto text-[9px] text-[var(--ink-text-faint)]">回合 {task.round_no}</span>
              </div>

              <div className="flex items-center gap-2">
                <div className="h-1 flex-1 rounded-full bg-[var(--ink-bg-elevated)]">
                  <div
                    className="h-full rounded-full bg-[var(--ink-text-muted)]"
                    style={{ width: `${task.progress}%` }}
                  />
                </div>
                <span className="text-[9px] text-[var(--ink-text-faint)]">{task.progress}%</span>
              </div>

              {task.next_step && (
                <div className="text-[10px] text-[var(--ink-text-faint)]">下一步: {task.next_step}</div>
              )}

              <div className="flex gap-1">
                {task.status === 'running' && (
                  <Button size="xs" variant="ghost" onClick={() => handleCancel(task.task_id)}>
                    <Ban size={10} strokeWidth={1.6} />
                    取消
                  </Button>
                )}
                {(task.status === 'failed' || task.status === 'cancelled') && (
                  <Button size="xs" variant="ghost" onClick={() => handleRetry(task.task_id)}>
                    <RefreshCw size={10} strokeWidth={1.6} />
                    重试
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
