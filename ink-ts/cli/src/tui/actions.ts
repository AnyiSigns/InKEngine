/**
 * TuiActions 桥接实现：绑定 host bridge 方法表（createHost 产物 handle.bridge），
 * 不新造第二套命令面；方法名 = plugins/commands 派生（编译期键由生成物锁定）。
 */

import type { BridgeHandler } from '@ink-ts/host';

import type { ApprovalCard, SessionSummary, TuiActions } from './types.js';

function call(
  bridge: ReadonlyMap<string, BridgeHandler>,
  autoApprove: boolean,
  method: string,
  params: unknown,
): Promise<unknown> {
  const handler = bridge.get(method);
  if (handler === undefined) {
    throw new Error(`bridge 方法缺失: ${method}`);
  }
  return Promise.resolve(handler(params, { autoApprove }));
}

/** records.sessions 视图行 → 会话摘要（缺省字段容错）。 */
function toSessionSummary(row: unknown): SessionSummary | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  if (typeof record.thread_id !== 'string' || record.thread_id === '') return null;
  return {
    thread_id: record.thread_id,
    title: typeof record.title === 'string' ? record.title : null,
    created_at: typeof record.created_at === 'number' ? record.created_at : null,
  };
}

function toApprovalCard(row: unknown): ApprovalCard | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  if (typeof record.thread_id !== 'string' || typeof record.key !== 'string') return null;
  return {
    thread_id: record.thread_id,
    key: record.key,
    node: typeof record.node === 'string' || record.node === null ? record.node : null,
    graph_path: Array.isArray(record.graph_path)
      ? (record.graph_path as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    payload: typeof record.payload === 'object' && record.payload !== null
      ? (record.payload as Record<string, unknown>)
      : undefined,
  };
}

/** 绑定 host bridge → TuiActions（ctx.autoApprove 与 cli 形态一致：缺省 false 走交互审批）。 */
export function createTuiActions(
  bridge: ReadonlyMap<string, BridgeHandler>,
  autoApprove = false,
): TuiActions {
  return {
    async listSessions(): Promise<SessionSummary[]> {
      const rows = (await call(bridge, autoApprove, 'records.sessions', undefined)) as unknown[];
      if (!Array.isArray(rows)) return [];
      return rows
        .map(toSessionSummary)
        .filter((session): session is SessionSummary => session !== null)
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    },
    async createSession(): Promise<SessionSummary> {
      const record = await call(bridge, autoApprove, 'sessions.create', {});
      const summary = toSessionSummary(record);
      if (summary === null) {
        throw new Error('sessions.create 返回异常（缺 thread_id）');
      }
      return summary;
    },
    async listMessages(threadId: string): Promise<unknown[]> {
      const result = (await call(bridge, autoApprove, 'sessions.messages', {
        thread_id: threadId,
      })) as { messages?: unknown[] } | null;
      return result === null || !Array.isArray(result.messages) ? [] : result.messages;
    },
    async send(threadId: string, input: string): Promise<unknown> {
      return call(bridge, autoApprove, 'rounds.send', { thread_id: threadId, input });
    },
    async listTodos(threadId: string): Promise<unknown> {
      const result = await call(bridge, autoApprove, 'rounds.todos', { thread_id: threadId });
      if (typeof result === 'object' && result !== null) {
        return (result as Record<string, unknown>).todo ?? result;
      }
      return result;
    },
    async listApprovals(): Promise<ApprovalCard[]> {
      const rows = (await call(bridge, autoApprove, 'approval.list', {})) as unknown[];
      if (!Array.isArray(rows)) return [];
      return rows
        .map(toApprovalCard)
        .filter((card): card is ApprovalCard => card !== null);
    },
    async resolveApproval(threadId: string, decision: unknown): Promise<unknown> {
      return call(bridge, autoApprove, 'approval.resolve', { thread_id: threadId, decision });
    },
  };
}
