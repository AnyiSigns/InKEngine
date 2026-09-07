/**
 * TUI 可变状态模型 + 纯辅助（事件尾部截断/输入编辑/选择行夹取）。
 * 状态为 controller 持有；视图只读；纯函数供测试。
 */

import type { ApprovalCard, EditorState, EventLine, SessionSummary, TuiMode } from './types.js';

/** 事件流尾部上限（环形裁剪，防内存无限增长）。 */
export const EVENT_TAIL = 200;

export interface TuiModel {
  mode: TuiMode;
  sessions: SessionSummary[];
  activeThread: string | null;
  input: string;
  cursor: number;
  events: EventLine[];
  messages: string[];
  approvals: ApprovalCard[];
  approvalIndex: number;
  sessionIndex: number;
  todoLines: string[];
  editor: EditorState | null;
  status: string;
  /** 回合运行中（发送后置位，防止并发第二发；事件仍持续进入）。 */
  running: boolean;
  /** 离开确认挂起（二次输入 yes 才退出）。 */
  quitting: boolean;
  done: boolean;
}

export function createModel(): TuiModel {
  return {
    mode: 'chat',
    sessions: [],
    activeThread: null,
    input: '',
    cursor: 0,
    events: [],
    messages: [],
    approvals: [],
    approvalIndex: 0,
    sessionIndex: 0,
    todoLines: [],
    editor: null,
    status: '',
    running: false,
    quitting: false,
    done: false,
  };
}

/** 追加事件行并裁剪尾部（纯函数返回新数组）。 */
export function pushEvent(model: TuiModel, line: EventLine): void {
  model.events = [...model.events, line];
  if (model.events.length > EVENT_TAIL) {
    model.events = model.events.slice(model.events.length - EVENT_TAIL);
  }
}

/** 在 index 处插入字符（编辑器与输入框共用）。 */
export function insertAt(value: string, cursor: number, char: string): { value: string; cursor: number } {
  const next = `${value.slice(0, cursor)}${char}${value.slice(cursor)}`;
  return { value: next, cursor: cursor + char.length };
}

/** 在 index 处删除前一个字符。 */
export function backspaceAt(value: string, cursor: number): { value: string; cursor: number } {
  if (cursor <= 0) return { value, cursor: 0 };
  const next = `${value.slice(0, cursor - 1)}${value.slice(cursor)}`;
  return { value: next, cursor: cursor - 1 };
}

/** 视图行滚动夹取（cur 越界时拉回边界）。 */
export function clampIndex(current: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(length - 1, current + delta));
}

/** 会话/审批等选择视图与 chat 视图的按键行为共用判定。 */
export function isEditorActive(model: TuiModel): boolean {
  return model.editor !== null;
}
