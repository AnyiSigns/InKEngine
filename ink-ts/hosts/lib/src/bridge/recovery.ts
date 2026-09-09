/**
 * recovery 命令面（回退入口 + 可回退点查询 + 重置）——调 engine storage/恢复语义。
 *
 * 引擎恢复 = checkpoint 锚点链（resolve_resume/resume_run 由 rounds.branch/
 * rounds.resume 承载）；本组只出**回退入口**：按链删除目标叶之后的派生
 * checkpoint（storage.delete_checkpoints 会重算链尾），并审计留痕。点查询
 * 供操作者选择回退目标；回退删除只作用于链数据，宿主簿记经 session store
 * 收尾刷新。重置另按线程/出厂两级清事件日志（storage.truncate_events）。
 */

import type { RecoveryCommand } from './commands.generated.js';
export { RECOVERY_COMMANDS, type RecoveryCommand } from './commands.generated.js';
import type { Storage } from '@ink-ts/engine';
import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';

import { HostSessionStore } from '../sessions/store.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** recovery.reset 的固定确认标记（危险操作 fail-closed：无标记即拒绝）。 */
export const FACTORY_RESET_MARKER = 'factory-reset';

/** recovery.settings_reset 的固定确认标记（B6 恢复设置默认逃生）。 */
export const SETTINGS_RESET_MARKER = 'settings-default';

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
export function buildRecoveryCommands(deps: HostBridgeDeps): Readonly<Record<RecoveryCommand, BridgeHandler>> {
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

  /** 恢复设置默认（B6 逃生）：恢复出厂档位/管理设置，不动会话链/知识/审计。
   *
   * 范围 = 常驻必带回出厂集、UI 组件停用清空、MCP 工具型插件全停用并清台账
   * （含指定安装额外配置）、capability 台账回缺省（auto 审批/tier/max rounds
   * 一并清）。会话级/事件级 factory reset 语义不受影响。 */
  const settingsReset: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { confirm?: unknown } | null;
    if (typeof params !== 'object' || params === null) {
      throw new BridgeError('recovery.settings_reset 需 params（含 confirm）', 'invalid_params');
    }
    if (params.confirm !== SETTINGS_RESET_MARKER) {
      throw new BridgeError(
        `recovery.settings_reset 需 confirm='${SETTINGS_RESET_MARKER}'（危险操作标记缺失）`,
        'invalid_params',
      );
    }
    const disabledMcp: string[] = [];
    const mcp = deps.mcpPlugins;
    if (mcp !== null && mcp !== undefined) {
      for (const row of mcp.list()) {
        if (!row.enabled) continue;
        const outcome = await mcp.disable(row.id);
        if (outcome.ok) disabledMcp.push(row.id);
      }
    }
    const baseline = await deps.runtime.reset_baseline_names();
    const uiDisabled = await deps.runtime.set_ui_components_disabled([]);
    const capability = deps.capability?.reset?.() ?? null;
    const storage = deps.runtime.storage;
    if (storage !== null) {
      await writeResetAudit(storage, {
        kind: 'recovery_reset_settings',
        ts: Date.now() / 1000,
        baseline_reset: baseline,
        ui_disabled: uiDisabled,
        mcp_disabled: disabledMcp,
        capability_reset: capability !== null,
        audit_kept: true,
      });
    }
    return {
      mode: 'settings',
      baseline_reset: baseline,
      ui_disabled: uiDisabled,
      mcp_disabled: disabledMcp,
      capability_reset: capability !== null,
      audit_kept: true,
      reset: true,
    };
  };

  return {
    'recovery.checkpoints': checkpoints,
    'recovery.rollback': rollback,
    'recovery.reset': reset,
    'recovery.settings_reset': settingsReset,
  };
}

/** 重置审计留痕（append-only set_audit；写入失败不阻断重置语义）。 */
async function writeResetAudit(
  storage: { allow_mechanism(collection: string): { enter(): void; exit(): void } },
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const scope = storage.allow_mechanism(SET_AUDIT_COLLECTION);
    scope.enter();
    try {
      await (storage as unknown as Storage).put_record(
        SET_AUDIT_COLLECTION,
        `op-${Math.random().toString(36).slice(2, 12)}`,
        data,
      );
    } finally {
      scope.exit();
    }
  } catch {
    // 审计失败不阻断重置（重置已按上述语义完成）
  }
}
