/**
 * 展示文本工具（TUI 纯函数格式化）：任意值紧凑单行化 + 截断 + 时间标签。
 * 事件 payload 多为 engine dict，取 type/阶段字段优先，其余 JSON 压缩。
 */

/** 单值紧凑文本上限（超长截断加省略号）。 */
export const MAX_TEXT = 240;

function compactString(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > MAX_TEXT ? `${single.slice(0, MAX_TEXT - 1)}…` : single;
}

/** 对象/数组 → 单行压缩 JSON（键序保留，值同层压缩）。 */
function compactJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, v: unknown): unknown => {
    if (typeof v === 'string') return compactString(v);
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  };
  try {
    const raw = JSON.stringify(value, replacer);
    return raw === undefined ? 'null' : compactString(raw);
  } catch {
    return '[unserializable]';
  }
}

/** 任意值 → 单行展示文本：字符串原样压缩，数字/布尔直出，其余压缩 JSON。 */
export function formatValue(value: unknown): string {
  if (typeof value === 'string') return compactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value) && value.length === 0) return '[]';
  return compactJson(value);
}

/** 事件对象 → 单行文本：优先关键字段（text/message/content/input），再退化为压缩 JSON。 */
export function formatEvent(topic: string, data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    for (const key of ['text', 'message', 'content', 'input', 'summary', 'reason'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        const brief = compactString(value);
        return `${topic} ${brief}`;
      }
    }
  }
  return `${topic} ${formatValue(data)}`;
}

/** 审批卡单行摘要（payload 压缩裁剪）。 */
export function formatApprovalCard(card: { key: string; node?: string | null }): string {
  const node = card.node === null || card.node === undefined ? '' : ` @${card.node}`;
  return `${card.key}${node}`;
}

/** 消息行投影（sessions.messages 行）→ 展示文本。 */
export function formatMessageRow(row: Record<string, unknown>): string {
  const kind = row.kind === 'tool' ? '⚙' : row.role === 'assistant' ? '⟨' : '⟩';
  const text = typeof row.text === 'string' && row.text.length > 0 ? row.text : formatValue(row);
  const title = typeof row.title === 'string' ? row.title : kind;
  return `${title} ${text}`;
}

/** 会话行标题（title 缺省回退 thread_id 后段）。 */
export function sessionTitle(session: { thread_id: string; title?: string | null }): string {
  const title = session.title !== null && session.title !== undefined && session.title !== ''
    ? session.title
    : `#${session.thread_id.slice(-8)}`;
  return `${session.thread_id} ${title}`;
}

/** 光标单行前缀（输入提示）。 */
export function padCursor(value: string, cursor: number): string {
  const head = value.slice(0, Math.max(0, Math.min(cursor, value.length)));
  const tail = value.slice(head.length);
  return `${head}█${tail}`;
}
