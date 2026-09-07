/**
 * TUI 纯渲染：TuiModel → 行数组（无 ANSI，便于测试与非 TTY 输出；
 * TTY 层整帧清屏重画）。视图只读模型，不含任何 IO。
 */

import { formatApprovalCard, formatMessageRow, formatValue, padCursor, sessionTitle } from './fmt.js';
import type { TuiModel } from './model.js';

const FRAME_MAX = 44;

/** 中部裁剪（保头尾、超长省略中间，frame 保持在 FRAME_MAX 内且 footer 恒在末行）。 */
function trimBody(body: string[], reserved: number): string[] {
  const max = FRAME_MAX - reserved;
  if (body.length <= max) return body;
  const headCount = Math.ceil(max * 0.6);
  const head = body.slice(0, headCount);
  const tail = body.slice(body.length - (max - headCount - 1));
  return [...head, `…（省略 ${body.length - head.length - tail.length} 行）`, ...tail];
}

function header(model: TuiModel): string {
  const thread = model.activeThread === null ? '（未选会话）' : sessionTitle({
    thread_id: model.activeThread,
    title: model.sessions.find((s) => s.thread_id === model.activeThread)?.title ?? null,
  });
  const run = model.running ? ' [运行中…]' : '';
  return `ink-ts TUI${run}  ${thread}  view=${model.mode}`;
}

function statusLine(model: TuiModel): string {
  return model.status === '' ? '' : `! ${model.status}`;
}

function chatBody(model: TuiModel): string[] {
  if (model.activeThread === null) {
    return ['尚无会话——到「sessions」视图按 n 新建后回车进入。'];
  }
  const lines: string[] = [];
  const reversed = [...model.messages].reverse();
  const recent = reversed.slice(0, 40).reverse();
  for (const line of recent) lines.push(line);
  if (model.messages.length === 0) lines.push('（会话暂无消息）');
  lines.push('—— 事件流 ——');
  const events = model.events.slice(-24);
  for (const event of events) lines.push(event.text);
  return lines;
}

function listBody(model: TuiModel): string[] {
  if (model.sessions.length === 0) return ['（无会话）按 n 新建。'];
  return model.sessions.map((session, index) => {
    const marker = index === model.sessionIndex ? '▶' : ' ';
    const active = session.thread_id === model.activeThread ? '*' : ' ';
    return `${marker}${active} ${sessionTitle(session)}`;
  });
}

function approvalCardDetail(model: TuiModel): string[] {
  const card = model.approvals[model.approvalIndex];
  if (card === undefined) return [];
  const path = Array.isArray(card.graph_path) ? card.graph_path.join(' → ') : '';
  const payload = card.payload === undefined ? '' : formatValue(card.payload);
  const out: string[] = [];
  out.push(`— 卡 ${model.approvalIndex + 1}/${model.approvals.length} ${card.key}（thread ${card.thread_id}）`);
  if (path !== '') out.push(`  路径 ${path}`);
  if (payload !== '') out.push(`  ${payload}`);
  return out;
}

function approvalsBody(model: TuiModel): string[] {
  if (model.approvals.length === 0) return ['（无待审批卡）按 a 刷新。'];
  const rows = model.approvals.map((card, index) => {
    const marker = index === model.approvalIndex ? '▶' : ' ';
    return `${marker} ${formatApprovalCard(card)}`;
  });
  return [...rows, ...approvalCardDetail(model)];
}

function todosBody(model: TuiModel): string[] {
  if (model.activeThread === null) return ['（未选会话）'];
  if (model.todoLines.length === 0) return ['（当前无待办）'];
  return model.todoLines;
}

const MODE_HINTS: Record<TuiModel['mode'], string> = {
  chat: '输入回车发送  / [2]会话 [3]待办 [4]审批  ctrl-c 退出',
  sessions: 'n 新建 / Enter 进入选中 / [1-4] 切视图',
  approvals: 'j/k 选择 / a 通过 / r 拒绝(填原因) / e 编辑内容 / t 终止 / [1-4] 切视图',
  todos: 'Enter 回聊天 / [1-4] 切视图',
};

function footer(model: TuiModel): string[] {
  if (model.editor !== null) {
    return [`${model.editor.title}（Enter 确认 / Esc 取消）`, padCursor(model.editor.value, model.editor.value.length)];
  }
  if (model.quitting) {
    return ['确认退出？输入 yes 确认，其它键取消。'];
  }
  const mode = model.mode;
  const hints = MODE_HINTS[mode];
  const prompt = mode === 'chat' ? `⟩ ${padCursor(model.input, model.cursor)}` : '';
  return [prompt === '' ? hints : prompt, hints];
}

/** 渲染整帧（纯文本行；非 TTY 直接打印，TTY 层清屏后写）。 */
export function renderFrame(model: TuiModel): string[] {
  const status = statusLine(model);
  const reserved = 3 + (status === '' ? 0 : 1);
  let body: string[];
  switch (model.mode) {
    case 'chat':
      body = chatBody(model);
      break;
    case 'sessions':
      body = listBody(model);
      break;
    case 'approvals':
      body = approvalsBody(model);
      break;
    case 'todos':
      body = todosBody(model);
      break;
  }
  const lines = [header(model)];
  if (status !== '') lines.push(status);
  lines.push(...trimBody(body, reserved));
  lines.push(...footer(model));
  return lines;
}

/** 消息行原始化（controller 打开会话时调用；不在此读模型）。 */
export function messageToLine(row: unknown): string {
  if (typeof row === 'object' && row !== null) {
    return formatMessageRow(row as Record<string, unknown>);
  }
  return formatValue(row);
}
