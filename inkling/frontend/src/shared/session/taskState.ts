/**
 * 任务级执行状态归约（task_state 子通道的数据面）。
 *
 * 归约源 = 回合内任务面事件（plan/spawn/tool/task 家族）；输出一份
 * 不可变快照，供任务面板按「步进计数 / 子任务各自状态」渲染。归约
 * 纯函数、脏数据防御（缺字段收敛为运行态/缺省），不抛。
 *
 * 子任务（spawn 展开 / 后台 task）以 key 关联：spawn 用 node_id、
 * task 用 task_id，tool_end 携带同 key 时按其归属的子任务收口，
 * 无 key 的 tool_end 仅计入计划步进（与子任务解耦，互不粘连）。
 */

import type { HubEvent } from './channelHub';

export type SubtaskStatus = 'pending' | 'running' | 'done' | 'cancelled' | 'failed';

export type SubtaskKind = 'spawn' | 'task';

/** 子任务行（spawn 展开或后台 task 各自独立一行）。 */
export interface SubtaskRow {
  key: string;
  label: string;
  kind: SubtaskKind;
  status: SubtaskStatus;
  /** 进度留痕（task_update 的 note/progress 文本）。 */
  progress?: string;
}

/** 任务级执行快照（state.task_state 通道根对象）。 */
export interface TaskState {
  planId: string | null;
  planActive: boolean;
  /** 计划步进总数（plan_start 载荷 steps；缺省 0）。 */
  stepsTotal: number;
  /** 已完成步进（tool_end / spawn_end / task_done 计数）。 */
  stepsDone: number;
  /** 子任务各行（spawn/task），顺序 = 事件到达顺序。 */
  subtasks: SubtaskRow[];
  /** 最近一次任务面事件时间戳。 */
  lastEventAt: number;
}

export function emptyTaskState(): TaskState {
  return {
    planId: null,
    planActive: false,
    stepsTotal: 0,
    stepsDone: 0,
    subtasks: [],
    lastEventAt: 0,
  };
}

/** 取事件负载关联键（spawn=node_id / task=task_id / 兜底 step_id）。 */
function eventKey(payload: Record<string, unknown>): string {
  const raw = payload.node_id ?? payload.task_id ?? payload.step_id ?? '';
  return typeof raw === 'string' ? raw : String(raw);
}

function upsertRow(rows: SubtaskRow[], row: SubtaskRow): SubtaskRow[] {
  const idx = rows.findIndex((r) => r.key === row.key);
  if (idx === -1) return [...rows, row];
  const next = [...rows];
  next[idx] = { ...next[idx], ...row };
  return next;
}

function patchRow(
  rows: SubtaskRow[],
  key: string,
  patch: Partial<SubtaskRow>,
): SubtaskRow[] {
  if (!key) return rows;
  return rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
}

/**
 * 任务面事件 → 任务状态归约（纯函数）。未落位类型原样返回（不崩）。
 * 缺字段按缺省收敛：spawn/task 无 key 时生成稳定占位键，保持可渲染。
 */
export function reduceTaskEvent(state: TaskState, event: HubEvent): TaskState {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const key = eventKey(payload);

  switch (event.type) {
    case 'plan_start': {
      const steps = Number(payload.steps ?? 0);
      return {
        ...emptyTaskState(),
        planId: typeof payload.plan_id === 'string' ? payload.plan_id : 'plan',
        planActive: true,
        stepsTotal: Number.isFinite(steps) ? steps : 0,
        lastEventAt: event.at,
      };
    }
    case 'plan_end':
      return { ...state, planActive: false, lastEventAt: event.at };

    case 'spawn_start': {
      const fallbackKey = `spawn-${state.subtasks.length}`;
      const row: SubtaskRow = {
        key: key || fallbackKey,
        label: typeof payload.label === 'string' && payload.label
          ? payload.label
          : typeof payload.node_id === 'string'
            ? payload.node_id
            : '子任务',
        kind: 'spawn',
        status: 'running',
      };
      return { ...state, subtasks: upsertRow(state.subtasks, row), lastEventAt: event.at };
    }
    case 'spawn_end': {
      const target = key || '';
      return {
        ...state,
        subtasks: patchRow(state.subtasks, target, { status: 'done' }),
        lastEventAt: event.at,
      };
    }

    case 'tool_start':
      // 工具开始仅作步进占位信号；子任务状态由 tool_end 收口（按 key 关联）
      return { ...state, lastEventAt: event.at };
    case 'tool_end': {
      const target = key || '';
      const matched = state.subtasks.some((r) => r.key === target && r.status === 'running');
      const next: TaskState = {
        ...state,
        stepsDone: state.stepsDone + 1,
        lastEventAt: event.at,
      };
      if (matched) {
        return { ...next, subtasks: patchRow(state.subtasks, target, { status: 'done' }) };
      }
      return next;
    }

    case 'task_start': {
      const fallbackKey = `task-${state.subtasks.length}`;
      const row: SubtaskRow = {
        key: key || fallbackKey,
        label: typeof payload.label === 'string' && payload.label
          ? payload.label
          : typeof payload.task_id === 'string'
            ? payload.task_id
            : '后台任务',
        kind: 'task',
        status: 'running',
      };
      return { ...state, subtasks: upsertRow(state.subtasks, row), lastEventAt: event.at };
    }
    case 'task_update': {
      const note = typeof payload.progress === 'string'
        ? payload.progress
        : typeof payload.note === 'string'
          ? payload.note
          : undefined;
      return {
        ...state,
        subtasks: patchRow(state.subtasks, key, { progress: note }),
        lastEventAt: event.at,
      };
    }
    case 'task_done': {
      const target = key || '';
      return {
        ...state,
        stepsDone: state.stepsDone + 1,
        subtasks: patchRow(state.subtasks, target, { status: 'done' }),
        lastEventAt: event.at,
      };
    }
    case 'task_cancelled':
      return {
        ...state,
        subtasks: patchRow(state.subtasks, key, { status: 'cancelled' }),
        lastEventAt: event.at,
      };

    default:
      return state;
  }
}
