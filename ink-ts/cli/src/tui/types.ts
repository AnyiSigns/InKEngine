/**
 * cli 交互 TUI（cli 面呈现层）共享类型。逻辑放 controller/model，视图为纯函数。
 */

/** 顶部功能视图。 */
export type TuiMode = 'chat' | 'sessions' | 'approvals' | 'todos';

/** 会话索引行（records.sessions 视图行投影，缺省容错显示）。 */
export interface SessionSummary {
  thread_id: string;
  title?: string | null;
  created_at?: number | null;
}

/** 事件流一行（引擎事件/状态摘要；topic 供过滤，text 为展示文本）。 */
export interface EventLine {
  topic: string;
  text: string;
}

/** 审批卡投影（approval.list 视图行）。 */
export interface ApprovalCard {
  thread_id: string;
  key: string;
  node?: string | null;
  graph_path?: string[];
  payload?: Record<string, unknown>;
}

/** 编辑器（审批 reason / edit 内容单行编辑；edit 内容为 JSON 文本）。 */
export interface EditorState {
  kind: 'reason' | 'edit';
  title: string;
  value: string;
}

/** 语义化按键（raw 终端字节解码产物；非 TTY 逐行输入亦映射到同一集合）。 */
export type KeyName =
  | 'enter'
  | 'backspace'
  | 'escape'
  | 'ctrl-c'
  | 'up'
  | 'down'
  | 'tab';

export type TuiIntent =
  | { kind: 'char'; char: string }
  | { kind: 'key'; name: KeyName };

/** 与宿主桥接的动作面（测试可注入 fake；真实实现绑定 host bridge 方法表）。 */
export interface TuiActions {
  listSessions(): Promise<SessionSummary[]>;
  createSession(): Promise<SessionSummary>;
  listMessages(threadId: string): Promise<unknown[]>;
  send(threadId: string, input: string): Promise<unknown>;
  listTodos(threadId: string): Promise<unknown>;
  listApprovals(): Promise<ApprovalCard[]>;
  resolveApproval(threadId: string, decision: unknown): Promise<unknown>;
}

/** 事件订阅面（EventHub 适配；on 返回解除订阅函数）。 */
export interface TuiEvents {
  on(cb: (line: EventLine) => void): () => void;
}
