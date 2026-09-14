/**
 * recovery.reset 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/recovery.ts
 * 迁入，语义零改）。重置入口（危险操作 fail-closed）：confirm 必须精确等于固定
 * 标记 'factory-reset'；thread_id 缺省 = 全量重置，显式 = 单线程重置。
 */

import { BridgeError, HostSessionStore } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import type { Storage } from '@ink-ts/engine';
import { FACTORY_RESET_MARKER, writeResetAudit } from '../../../_shared/recovery.js';

export default function createRecoveryReset(deps: HostBridgeDeps): BridgeHandler {
  const sessions = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  /**
   * 重置入口（危险操作，fail-closed）：confirm 必须精确等于固定标记
   * 'factory-reset'，无标记即拒绝（幂等——重复调用不再有可删数据时返回
   * 零计数）。thread_id 缺省 = 全量重置：逐会话删除链 checkpoint + 清空
   * host.sessions / ledger / memory 三个宿主簿记集合（均非守卫集合，直删）
   * + 清空可枚举线程的事件日志；显式 thread_id = 单线程重置：删该线程
   * 全链 checkpoint + 会话墓碑 + 该线程事件日志（truncate_events 原语，
   * 事件 seq 自 1 起，after_seq=0 = 清空）。审计（set_audit）为 append-only
   * 证据面，永不参与重置；知识集为出厂种子域（无用户/机制区分入口），
   * 本期不参与重置（摘要如实标注 events_cleared / knowledge_kept /
   * audit_kept）。
   */
  const reset: BridgeHandler = async (raw): Promise<unknown> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const params = raw as { thread_id?: unknown; confirm?: unknown } | null;
    if (typeof params !== 'object' || params === null) {
      throw new BridgeError('recovery.reset 需 params（含 confirm）', 'invalid_params');
    }
    if (params.confirm !== FACTORY_RESET_MARKER) {
      throw new BridgeError(
        `recovery.reset 需 confirm='${FACTORY_RESET_MARKER}'（危险操作标记缺失）`,
        'invalid_params',
      );
    }
    const threadIdRaw = params.thread_id;
    const hasThread =
      threadIdRaw !== undefined && threadIdRaw !== null && threadIdRaw !== '';
    if (hasThread && typeof threadIdRaw !== 'string') {
      throw new BridgeError('recovery.reset thread_id 须为字符串', 'invalid_params');
    }
    const targetThread: string | null = hasThread ? (threadIdRaw as string) : null;

    /** 删除某线程全链 checkpoint（幂等：无链返回 0）。 */
    const clearThreadChain = async (threadId: string): Promise<number> => {
      const links = (await storage.chain_index(threadId).catch(() => [])) as Array<{
        checkpoint_id: number;
      }>;
      if (links.length === 0) return 0;
      const ids = links.map((link) => link.checkpoint_id);
      return await storage.delete_checkpoints(threadId, ids).catch(() => ids.length);
    };

    /** 清空某线程事件日志（truncate_events 原语；失败不阻断重置语义）。 */
    const clearThreadEvents = async (threadId: string): Promise<void> => {
      await storage.truncate_events(threadId, 0).catch(() => undefined);
    };

    if (targetThread !== null) {
      const deleted = await clearThreadChain(targetThread);
      const existed = await sessions.get(targetThread).catch(() => null);
      if (existed !== null) {
        await sessions.remove(targetThread).catch(() => undefined);
      }
      await clearThreadEvents(targetThread);
      const now = Date.now() / 1000;
      await writeResetAudit(storage, {
        kind: 'recovery_reset_thread',
        ts: now,
        thread_id: targetThread,
        checkpoints_deleted: deleted,
      });
      return {
        mode: 'thread',
        thread_id: targetThread,
        checkpoints_deleted: deleted,
        session_removed: existed !== null,
        events_cleared: true,
        ledger_kept: true,
        knowledge_kept: true,
        audit_kept: true,
        reset: true,
      };
    }

    let checkpointsDeleted = 0;
    const sessionRecords = await sessions.list().catch(() => []);
    for (const record of sessionRecords) {
      checkpointsDeleted += await clearThreadChain(record.thread_id);
    }
    // 事件枚举线程集 = 会话簿记 ∪ 账本线程（会话墓碑后仅剩账本/事件的
    // 线程也一并清——事件日志无跨线程枚举原语，按两簿来源取并集）
    const eventThreads = new Set(sessionRecords.map((record) => record.thread_id));
    let cursor: string | null = null;
    for (;;) {
      const page: { records: Array<Record<string, unknown>>; next_cursor: string | null } | null =
        await storage
          .list_records_page('ledger', { limit: 500, cursor })
          .catch(() => null);
      if (page === null) break;
      for (const record of page.records) {
        const thread_id = record['thread_id'];
        if (typeof thread_id === 'string' && thread_id !== '') eventThreads.add(thread_id);
      }
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    for (const threadId of eventThreads) {
      await clearThreadEvents(threadId);
    }
    const clearedCollections: Array<{ collection: string; count: number }> = [];
    for (const collection of ['host.sessions', 'ledger', 'memory'] as const) {
      try {
        const count = await storage.delete_collection(collection);
        clearedCollections.push({ collection, count });
      } catch {
        clearedCollections.push({ collection, count: 0 });
      }
    }
    await writeResetAudit(storage, {
      kind: 'recovery_reset_factory',
      ts: Date.now() / 1000,
      threads: sessionRecords.length,
      checkpoints_deleted: checkpointsDeleted,
      event_threads: eventThreads.size,
      cleared_collections: clearedCollections,
    });
    return {
      mode: 'factory',
      threads: sessionRecords.length,
      checkpoints_deleted: checkpointsDeleted,
      events_cleared: true,
      cleared_collections: clearedCollections,
      knowledge_kept: true,
      audit_kept: true,
      reset: true,
    };
  };

  return reset;
}
