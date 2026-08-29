/**
 * 任务级执行面板：消费 state.task_state 子通道（plan/spawn/tool 归约面）。
 *
 * 呈现面：步进计数（第几步 / 总数 / 剩余）+ 子任务各自状态行。
 * spawn 展开后子任务独立成行（与事件流并行不粘连）；缺字段降级为
 * 运行态/缺省文案，不抛。纯渲染：bindValue = task_state 快照。
 */

import type { TaskState, SubtaskRow } from '@/shared/session/taskState';

const STATUS_LABELS: Record<SubtaskRow['status'], string> = {
  pending: '待命',
  running: '运行中',
  done: '完成',
  cancelled: '已取消',
  failed: '失败',
};

const STATUS_CLASS: Record<SubtaskRow['status'], string> = {
  pending: 'ink-text-faint',
  running: 'ink-accent',
  done: 'ink-text-muted',
  cancelled: 'ink-text-faint',
  failed: 'ink-accent',
};

export interface TaskPanelProps {
  bindValue?: unknown;
}

function readState(bindValue: unknown): TaskState | null {
  if (!bindValue || typeof bindValue !== 'object') return null;
  const candidate = bindValue as Partial<TaskState>;
  if (!Array.isArray(candidate.subtasks)) return null;
  return {
    planId: candidate.planId ?? null,
    planActive: candidate.planActive === true,
    stepsTotal: Number(candidate.stepsTotal ?? 0),
    stepsDone: Number(candidate.stepsDone ?? 0),
    subtasks: candidate.subtasks as SubtaskRow[],
    lastEventAt: Number(candidate.lastEventAt ?? 0),
  };
}

/** 任务级执行面板（状态卡片：子任务各自状态 + 步进计数）。 */
export function TaskPanel({ bindValue }: TaskPanelProps) {
  const state = readState(bindValue);

  if (!state) {
    return (
      <section className="ink-panel p-3" data-ui="task_panel">
        <div className="text-[11px] ink-text-faint">暂无任务执行（未开始规划）</div>
      </section>
    );
  }

  const remaining = Math.max(0, state.stepsTotal - state.stepsDone);
  const activeSubtasks = state.subtasks.filter((s) => s.status === 'running').length;

  return (
    <section className="ink-panel p-3" data-ui="task_panel">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold tracking-tight">执行面板</span>
        {state.planActive ? (
          <span className="ink-live-dot ink-accent" aria-hidden />
        ) : null}
        <span className="ml-auto text-[10px] ink-text-faint">
          步进 {state.stepsDone}/{state.stepsTotal} · 剩余 {remaining}
        </span>
      </div>

      <div className="mt-1 flex gap-3 text-[10px] ink-text-muted">
        <span>子任务 {state.subtasks.length} 行</span>
        <span>运行中 {activeSubtasks}</span>
      </div>

      {state.subtasks.length === 0 ? (
        <div className="mt-2 text-[11px] ink-text-faint">无子任务（spawn/task 展开后在此逐行可见）</div>
      ) : (
        <ul className="mt-2 space-y-1">
          {state.subtasks.map((row) => (
            <li
              key={row.key}
              className="flex items-center gap-2 rounded-md border border-dashed ink-border px-2 py-1"
              data-ui="subtask_row"
              data-status={row.status}
            >
              <span className="rounded px-1 py-px text-[9px] ink-elevated">
                {row.kind === 'spawn' ? '展开' : '后台'}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] ink-text-base">{row.label}</span>
              {row.progress ? (
                <span className="truncate text-[9px] ink-text-faint" data-ui="subtask_progress">
                  {row.progress}
                </span>
              ) : null}
              <span className={`text-[10px] ${STATUS_CLASS[row.status]}`} data-ui="subtask_status">
                {STATUS_LABELS[row.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
