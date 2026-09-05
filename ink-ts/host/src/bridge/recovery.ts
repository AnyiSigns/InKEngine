/**
 * recovery 命令面（回退入口 + 可回退点查询）——调 engine storage/恢复语义。
 *
 * 引擎恢复 = checkpoint 锚点链（resolve_resume/resume_run 由 rounds.branch/
 * rounds.resume 承载）；本组只出**回退入口**：按链删除目标叶之后的派生
 * checkpoint（storage.delete_checkpoints 会重算链尾），并审计留痕。点查询
 * 供操作者选择回退目标；回退删除只作用于链数据，宿主簿记经 session store
 * 收尾刷新。
 */

import type { Storage } from '@ink-ts/engine';
import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';

import { HostSessionStore } from '../sessions/store.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

function requireThread(raw: unknown, method: string): { thread_id: string; checkpoint_id: number | null } {
  const params = raw as { thread_id?: unknown; checkpoint_id?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError(`${method} 需 params.thread_id`, 'invalid_params');
  }
  const cid = params.checkpoint_id;
  const checkpoint_id =
    cid === undefined || cid === null
      ? null
      : Number.isInteger(cid)
        ? (cid as number)
        : null;
  if (cid !== undefined && cid !== null && checkpoint_id === null) {
    throw new BridgeError(`${method} checkpoint_id 须为整数`, 'invalid_params');
  }
  return { thread_id: params.thread_id, checkpoint_id };
}

/** 可回退点查询：链行降序 + 中断锚点标注。 */
export function buildRecoveryHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const sessions = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  const checkpoints: BridgeHandler = async (raw): Promise<unknown> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const thread_id = requireThread(raw, 'recovery.checkpoints').thread_id;
    const chain = await storage.chain_index(thread_id).catch(() => []);
    const rows = chain.map((link) => ({
      checkpoint_id: link.checkpoint_id,
      parent_id: link.parent_id,
      reason: link.reason,
      graph_path: [...link.graph_path],
    }));
    rows.sort((a, b) => b.checkpoint_id - a.checkpoint_id);
    return {
      thread_id,
      latest: rows[0]?.checkpoint_id ?? null,
      points: rows,
    };
  };

  /** 回退：删除目标叶（缺省 = 链尾叶的父）之后派生的 checkpoint。 */
  const rollback: BridgeHandler = async (raw): Promise<unknown> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const { thread_id, checkpoint_id } = requireThread(raw, 'recovery.rollback');
    const chain = (await storage.chain_index(thread_id).catch(() => [])) as Array<{
      checkpoint_id: number;
      parent_id: number | null;
    }>;
    if (chain.length === 0) {
      throw new BridgeError('该会话无链可回退', 'no_checkpoints');
    }
    const tail = chain.reduce(
      (max, link) => (link.checkpoint_id > max ? link.checkpoint_id : max),
      chain[0]!.checkpoint_id,
    );
    const parents = new Map<number, number | null>(chain.map((link) => [link.checkpoint_id, link.parent_id]));
    const target = checkpoint_id ?? parents.get(tail) ?? null;
    if (target === null || !parents.has(target)) {
      throw new BridgeError(
        checkpoint_id === null ? '链尾无父节点，无法再回退' : '目标 checkpoint 不在该会话链上',
        'invalid_target',
      );
    }
    if (target === tail) {
      throw new BridgeError('目标已是链尾（无派生节点可删）', 'invalid_target');
    }
    // 收集自链尾向上直至目标的派生节点（不含目标本身）
    const toDelete: number[] = [];
    let cursor: number | null = tail;
    while (cursor !== null && cursor !== target) {
      toDelete.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    if (toDelete.length === 0) {
      throw new BridgeError('链结构与目标不一致（派生链断裂）', 'invalid_target');
    }
    const deleted = await storage.delete_checkpoints(thread_id, toDelete);
    const now = Date.now() / 1000;
    try {
      const scope = storage.allow_mechanism(SET_AUDIT_COLLECTION);
      scope.enter();
      try {
        await storage.put_record(SET_AUDIT_COLLECTION, `op-${Math.random().toString(36).slice(2, 12)}`, {
          type: 'recovery_rollback',
          ts: now,
          thread_id,
          target,
          deleted: deleted,
        });
      } finally {
        scope.exit();
      }
    } catch {
      // 审计失败不阻断回退（回退已按链删除完成）
    }
    const tree = await sessions.branch_tree(thread_id);
    return { thread_id, target, deleted, current_leaf: tree.current_leaf };
  };

  return new Map<string, BridgeHandler>([
    ['recovery.checkpoints', checkpoints],
    ['recovery.rollback', rollback],
  ]);
}
