/**
 * recovery.rollback 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/recovery.ts
 * 迁入，语义零改）。回退入口：按链删除目标叶之后的派生 checkpoint，并审计留痕。
 */

import { BridgeError, HostSessionStore } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import type { Storage } from '@ink-ts/engine';
import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';
import { requireThread } from '../../../_shared/recovery.js';

export default function createRecoveryRollback(deps: HostBridgeDeps): BridgeHandler {
  const sessions = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

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

  return rollback;
}
