/**
 * sessions 命令面（create/rename/delete/refresh/tree/messages）——会话宿主
 * 薄服务出口。
 *
 * 薄簿记读写统一经 HostSessionStore（rounds 收尾亦走同一服务）；链/分支树
 * 为引擎 checkpoint 链数据面推导（不落第二份台账）。messages = 链记录投影
 * （沿链主线的每轮 checkpoint state 消息增量，无第二份消息台账）。
 * 机制语义全在引擎。
 */

import type { SessionsCommand } from './commands.generated.js';
export { SESSIONS_COMMANDS, type SessionsCommand } from './commands.generated.js';
import type { Storage } from '@ink-ts/engine';

import { HostSessionStore } from '../sessions/store.js';
import type { HostSessionRecord } from '../sessions/model.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { sessionToView } from './records.js';

/** 链消息持久化键（组装回合引擎 messages 形态；旧 _tool_messages 链兼容）。 */
const MESSAGE_STATE_KEYS = ['_tool_messages', 'messages'] as const;

function requireThread(raw: unknown, method: string): string {
  const params = raw as { thread_id?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError(`${method} 需 params.thread_id`, 'invalid_params');
  }
  return params.thread_id;
}

function sessionOrThrow(record: HostSessionRecord | null, thread_id: string): HostSessionRecord {
  if (record === null) {
    throw new BridgeError(`会话不存在: ${thread_id}`, 'session_not_found');
  }
  return record;
}


export function buildSessionsCommands(deps: HostBridgeDeps): Readonly<Record<SessionsCommand, BridgeHandler>> {
  const store = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  const create: BridgeHandler = async (raw): Promise<unknown> => {
    // params 缺省/显式 null 均视为「未指定 thread_id」（web 无参调用 create
    // 时线上 params 为 undefined，直接判空必须用可选链——不能只判 null）。
    const params = raw as { thread_id?: unknown } | null | undefined;
    const thread_id =
      params !== null && params !== undefined
      && typeof params.thread_id === 'string'
      && params.thread_id !== ''
        ? params.thread_id
        : undefined;
    const record = await store.create(thread_id);
    return sessionToView(record);
  };

  const rename: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { thread_id?: unknown; title?: unknown } | null;
    if (
      typeof params !== 'object'
      || params === null
      || typeof params.thread_id !== 'string'
      || params.thread_id === ''
    ) {
      throw new BridgeError('sessions.rename 需 params.thread_id', 'invalid_params');
    }
    if (typeof params.title !== 'string' || params.title.trim() === '') {
      throw new BridgeError('sessions.rename 需 params.title（非空字符串）', 'invalid_params');
    }
    const record = sessionOrThrow(await store.rename(params.thread_id, params.title), params.thread_id);
    return sessionToView(record);
  };

  const deleteSession: BridgeHandler = async (raw): Promise<unknown> => {
    const thread_id = requireThread(raw, 'sessions.delete');
    await store.remove(thread_id);
    return { thread_id, deleted: true };
  };

  const refresh: BridgeHandler = async (raw): Promise<unknown> => {
    const thread_id = requireThread(raw, 'sessions.refresh');
    const record = sessionOrThrow(await store.refresh(thread_id), thread_id);
    return sessionToView(record);
  };

  const tree: BridgeHandler = async (raw): Promise<unknown> => {
    const thread_id = requireThread(raw, 'sessions.tree');
    return store.branch_tree(thread_id);
  };

  /**
   * 会话消息回取（records 链投影）：主线链叶 checkpoint 的 state 已含整轮
   * 消息链累积（回合按前缀续写），读叶状态一次即得最终消息序列——不逐
   * checkpoint 全量反序列化（O(M) 个快照回放 → 单快照读）。消息行 id 优先
   * 取消息自身 id，缺省合成 `${thread_id}:${index}`；created_at = 引入该
   * 消息链的叶 checkpoint 时间戳。返回消息按时间正序（首条在最先）。
   */
  const messages: BridgeHandler = async (raw): Promise<unknown> => {
    const thread_id = requireThread(raw, 'sessions.messages');
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const chain = (await storage.chain_index(thread_id).catch(() => [])) as Array<{
      checkpoint_id: number;
    }>;
    if (chain.length === 0) return { thread_id, messages: [] };
    const leafId = chain.reduce(
      (max, link) => (link.checkpoint_id > max ? link.checkpoint_id : max),
      chain[0]!.checkpoint_id,
    );
    const leaf = await storage.get_checkpoint(leafId).catch(() => null);
    if (leaf === null) return { thread_id, messages: [] };
    const state = leaf.state as Record<string, unknown>;
    interface MessageRow {
      id: string;
      kind: string;
      text?: string;
      role?: string;
      round_id?: string;
      created_at: number;
      meta?: Record<string, unknown>;
    }
    // 展示态优先：宿主在回合收尾把 user/assistant 正文、think 卡、工具卡
    // 持久化到 host.sessions.display_messages（独立于上下文 messages，不喂
    // 模型），刷新据此恢复前端完整消息流。无（旧链）则回退上下文投射。
    const sessionRecord = await store.get(thread_id).catch(() => null);
    const displayRaw = sessionRecord?.display_messages ?? null;
    if (Array.isArray(displayRaw)) {
      const rows: MessageRow[] = [];
      for (const item of displayRaw) {
        if (typeof item !== 'object' || item === null) continue;
        const record = item as Record<string, unknown>;
        const kind = typeof record['kind'] === 'string' ? record['kind'] : 'message';
        const content = typeof record['content'] === 'string'
          ? record['content']
          : typeof record['text'] === 'string'
            ? record['text']
            : '';
        const stepId = typeof record['step_id'] === 'string' ? record['step_id'] : null;
        const meta: Record<string, unknown> = {};
        if (typeof record['tool'] === 'string' && record['tool'] !== '') meta['tool'] = record['tool'];
        const title = typeof record['title'] === 'string' ? record['title'] : '';
        const args = typeof record['args'] === 'string' ? record['args'] : '';
        const summary = typeof record['summary'] === 'string' ? record['summary'] : '';
        const toolStatus = typeof record['toolStatus'] === 'string' ? record['toolStatus'] : undefined;
        const status = typeof record['status'] === 'string' ? record['status'] : undefined;
        if (args !== '') meta['args'] = args;
        if (summary !== '') meta['output'] = summary;
        if (toolStatus !== undefined) meta['toolStatus'] = toolStatus;
        if (status !== undefined) meta['status'] = status;
        const role = typeof record['role'] === 'string' ? record['role'] : undefined;
        // 引擎展示态正文行原生带 round（回合归属；auto 轮 = auto:* 前缀），
        // 透传给前端刷新投影，消息流据此重建 auto 轮徽标/回合分隔。
        const round = typeof record['round'] === 'string' && record['round'] !== '' ? record['round'] : undefined;
        rows.push({
          id: stepId ?? `${thread_id}:${rows.length}`,
          kind: kind === 'thinking' ? 'thinking' : kind === 'tool' ? 'tool' : 'message',
          text: content,
          created_at: leaf.created_at,
          ...(role !== undefined ? { role } : {}),
          ...(round !== undefined ? { round_id: round } : {}),
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
        });
      }
      return { thread_id, messages: rows };
    }
    // 回退：旧链无 display_messages → 从上下文 messages 投射（历史会话兼容）
    let list: unknown[] | null = null;
    for (const key of MESSAGE_STATE_KEYS) {
      if (Array.isArray(state[key])) {
        list = state[key] as unknown[];
        break;
      }
    }
    const rows: MessageRow[] = [];
    let seq = 0;
    // 工具调用起始关联：assistant 的 tool_calls id → 待闭合 tool 卡 index
    const openTools = new Map<string, number>();
    for (const item of list ?? []) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const role = typeof record['role'] === 'string' ? record['role'] : null;
      if (role === null) continue;
      const text = typeof record['content'] === 'string' ? record['content'] : '';
      const meta: Record<string, unknown> = {};
      const ownId = typeof record['id'] === 'string' && record['id'] !== ''
        ? record['id']
        : null;
      const calls = Array.isArray(record['tool_calls'])
        ? (record['tool_calls'] as Array<{ name?: unknown; id?: unknown }>)
            .map((call) => ({
              name: typeof call['name'] === 'string' ? call['name'] : null,
              id: typeof call['id'] === 'string' ? call['id'] : null,
            }))
            .filter((c): c is { name: string; id: string | null } => c.name !== null)
        : [];
      if (calls.length > 0) meta['tool_calls'] = calls.map((c) => c.name);
      // assistant 正文投射（含 tool 结果；thinking 展示态由宿主另存，不在引擎上下文）
      if (text.trim() !== '') {
        rows.push({
          id: ownId ?? `${thread_id}:${seq}`,
          kind: role === 'tool' ? 'tool' : 'message',
          text,
          role,
          created_at: leaf.created_at,
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
        });
        seq += 1;
      }
      // 工具调用起始投射（工具卡）：后续 role:'tool' 结果消息按 tool_call_id 闭合
      for (const call of calls) {
        const toolIndex = rows.length;
        rows.push({
          id: `${ownId ?? `${thread_id}:${seq}`}:tool:${call.name}`,
          kind: 'tool',
          text: call.name,
          role: 'tool',
          created_at: leaf.created_at,
          meta: { tool: call.name },
        });
        seq += 1;
        if (call.id !== null) openTools.set(call.id, toolIndex);
      }
      // 工具结果消息（role:'tool'）：闭合最近的同名工具卡（补输出 text）
      if (role === 'tool' && text.trim() !== '') {
        const toolCallId = typeof record['tool_call_id'] === 'string' ? record['tool_call_id'] : null;
        const targetIndex = toolCallId !== null ? (openTools.get(toolCallId) ?? null) : null;
        if (targetIndex !== null && rows[targetIndex] !== undefined) {
          rows[targetIndex]!.meta = { ...(rows[targetIndex]!.meta ?? {}), output: text };
        } else {
          rows.push({
            id: ownId ?? `${thread_id}:${seq}`,
            kind: 'tool',
            text: text.length > 120 ? text.slice(0, 120) : text,
            role: 'tool',
            created_at: leaf.created_at,
            meta: { output: text },
          });
          seq += 1;
        }
      }
    }
    return { thread_id, messages: rows };
  };

  return {
    'sessions.create': create,
    'sessions.rename': rename,
    'sessions.delete': deleteSession,
    'sessions.refresh': refresh,
    'sessions.tree': tree,
    'sessions.messages': messages,
  };
}
