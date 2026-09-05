/**
 * sessions 命令面（create/rename/delete/refresh/tree）——会话宿主薄服务出口。
 *
 * 薄簿记读写统一经 HostSessionStore（rounds 收尾亦走同一服务）；链/分支树
 * 为引擎 checkpoint 链数据面推导（不落第二份台账）。机制语义全在引擎。
 */

import type { Storage } from '@ink-ts/engine';

import { HostSessionStore } from '../sessions/store.js';
import type { HostSessionRecord } from '../sessions/model.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { sessionToView } from './records.js';

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

export function buildSessionsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const store = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  const create: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { thread_id?: unknown } | null;
    const thread_id =
      params !== null && typeof params.thread_id === 'string' && params.thread_id !== ''
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

  return new Map<string, BridgeHandler>([
    ['sessions.create', create],
    ['sessions.rename', rename],
    ['sessions.delete', deleteSession],
    ['sessions.refresh', refresh],
    ['sessions.tree', tree],
  ]);
}
