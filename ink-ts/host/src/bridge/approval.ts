/**
 * approval 命令面（审批卡查询 / 裁决）——语义留在引擎 approval/review_card/
 * interrupt（本层只接线：读引擎挂起卡 + 决议重入）。
 *
 * 挂起卡 = 引擎 interrupt 状态（随 checkpoint 持久化）。查询按会话线程取链尾
 * 挂起卡（read checkpoint interrupt：引擎无常驻静态引擎，链尾中断卡即引擎
 * 链尾挂起卡状态）；裁决 = runtime.resume_run 注入决议（decision 形态与
 * approve_before_execute 注入口径一致：字符串 accept/reject/terminate 或
 * {decision, reason?, edited_content?}）。
 */

import type { InterruptState } from '@ink-ts/engine';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { toJsonSafe } from './records.js';

/** 合法决议取值（引擎 approval VALID_DECISIONS 子集；auto 非注入决议）。 */
const INJECTABLE_DECISIONS = ['accept', 'edit', 'reject', 'terminate'] as const;

interface ApprovalCardView {
  thread_id: string;
  key: string;
  node: string | null;
  graph_path: string[];
  payload: Record<string, unknown>;
}

function requireThread(raw: unknown): string {
  const params = raw as { thread_id?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError('approval 命令需 params.thread_id', 'invalid_params');
  }
  return params.thread_id;
}

/** 校验决议注入形态（引擎 resolve_decision 亦会 fail-closed，此处前置报错）。 */
function validateDecision(raw: unknown): unknown {
  if (typeof raw === 'string') {
    if (!(INJECTABLE_DECISIONS as readonly string[]).includes(raw)) {
      throw new BridgeError(
        `非法决议字符串: '${raw}'（合法: ${INJECTABLE_DECISIONS.join(', ')}）`,
        'invalid_decision',
      );
    }
    return raw;
  }
  const record = raw as { decision?: unknown; reason?: unknown; edited_content?: unknown } | null;
  if (typeof record !== 'object' || record === null || typeof record.decision !== 'string') {
    throw new BridgeError('approval.resolve decision 须为字符串或含 decision 的对象', 'invalid_decision');
  }
  if (!(INJECTABLE_DECISIONS as readonly string[]).includes(record.decision)) {
    throw new BridgeError(
      `非法决议: '${record.decision}'（合法: ${INJECTABLE_DECISIONS.join(', ')}）`,
      'invalid_decision',
    );
  }
  if (record.decision === 'edit' && !('edited_content' in record)) {
    throw new BridgeError('edit 决议需 edited_content', 'invalid_decision');
  }
  return record;
}

export function buildApprovalHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  /** 链尾挂起卡读取（引擎无常驻静态引擎：直接读 checkpoint interrupt——与
   *  引擎链尾挂起卡状态同源，裁决经 runtime.resume_run 按图重建续跑）。 */
  async function latestInterrupt(thread_id: string): Promise<InterruptState | null> {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时引擎未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    const latest = await storage.get_latest_checkpoint(thread_id).catch(() => null);
    return latest === null || latest.interrupt === null ? null : latest.interrupt;
  }

  const list: BridgeHandler = async (raw): Promise<ApprovalCardView[]> => {
    const params = raw as { thread_id?: unknown } | null;
    const threads =
      params !== null && typeof params.thread_id === 'string' && params.thread_id !== ''
        ? [params.thread_id]
        : [];
    const storage = deps.runtime.storage;
    if (threads.length === 0 && storage !== null) {
      const records = await storage.list_records('host.sessions').catch(() => []);
      for (const record of records) {
        const thread_id = record['thread_id'];
        if (typeof thread_id === 'string' && thread_id !== '') threads.push(thread_id);
      }
    }
    const cards: ApprovalCardView[] = [];
    for (const thread_id of threads) {
      const interrupt = await latestInterrupt(thread_id);
      if (interrupt === null) continue;
      cards.push({
        thread_id,
        key: interrupt.key,
        node: interrupt.node,
        graph_path: [...interrupt.graph_path],
        payload: interrupt.payload as Record<string, unknown>,
      });
    }
    return cards;
  };

  const resolve: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { thread_id?: unknown; decision?: unknown } | null;
    if (
      typeof params !== 'object'
      || params === null
      || typeof params.thread_id !== 'string'
      || params.thread_id === ''
    ) {
      throw new BridgeError('approval.resolve 需 params.thread_id', 'invalid_params');
    }
    const decision = validateDecision(params.decision);
    // 决议直传裸决议：resume_run 内部读链尾挂起卡并按 interrupt key 包装注入
    // （宿主不再手工按 key 包装——双重包装会让决议命中 invalid 回落 reject）。
    let result: unknown;
    try {
      result = await deps.runtime.resume_run(params.thread_id, decision as never);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('无挂起审批卡') || message.includes('挂起卡已失效')) {
        throw new BridgeError(message, 'no_pending_approval');
      }
      throw error;
    }
    return { thread_id: params.thread_id, resolved: true, result: toJsonSafe(result) };
  };

  return new Map<string, BridgeHandler>([
    ['approval.list', list],
    ['approval.resolve', resolve],
  ]);
}
