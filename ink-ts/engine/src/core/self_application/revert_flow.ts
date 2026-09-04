/**
 * 回退机制函数（core/self_application.py SelfApplicationPipeline.revert
 * 移植；由 SelfApplicationPipeline.revert 委托，≤350 行类级拆分）。
 *
 * 回退 = 链级操作：仅允许回退链尾补丁（其上存在后继补丁 = 拒绝，保持
 * 链完整性）。回退 = 组装到目标版本为新的 base（append-only：旧链数据
 * 在审计中完整保留）。链尾补丁 = 版本 N，回退 N = 组装到 N-1。
 */

import type { ApprovalInterruptContext } from '../approval/approval.js';
import {
  approve_before_execute,
  DECISION_REJECT,
  DECISION_TERMINATE,
} from '../approval/approval.js';
import { GraphDefinitionError } from '../errors.js';

import {
  _SET_AUDIT_COLLECTION,
  AUDIT_STATUS_CONFLICT,
  AUDIT_STATUS_REJECTED,
  AUDIT_STATUS_REVERTED,
  AUDIT_STATUS_REVERTED_NOTIFY_FAILED,
} from './constants.js';
import { PatchOutcome } from './patch_outcome.js';
import type { SelfApplicationPipeline } from './pipeline.js';

/** 判定钩子结果为 thenable（Python ``hasattr(result, '__await__')`` 口径）。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && value !== undefined && typeof (value as PromiseLike<unknown>).then === 'function';
}

/**
 * 回退指定补丁（仅链尾）：审批确认后落审计 + 链级回退。
 * 回退是形态变更：与提案同走审批（默认 L1 弹卡）。
 */
export async function run_revert(
  pipeline: SelfApplicationPipeline,
  ctx: ApprovalInterruptContext,
  patch_id: number,
  reason: string,
  round_id: string | null,
): Promise<PatchOutcome> {
  let current = await pipeline.chain.current_version();
  if (patch_id !== current) {
    throw new GraphDefinitionError(
      `仅允许回退链尾补丁: 目标 #${patch_id}，链尾 #${current}`
        + '（其上存在后继补丁或越界——先回退后继，保持链完整性）',
    );
  }
  const targetVersion = patch_id - 1;
  if (targetVersion < 1) {
    throw new GraphDefinitionError('回退目标越界: 版本 1 为集基线，不可回退');
  }
  const action: Record<string, unknown> = {
    tool: 'revert_patch',
    patch_id,
    summary: `回退补丁 #${patch_id}`,
    reason,
  };
  const approval = await approve_before_execute(
    ctx,
    `revert:${patch_id}`,
    action,
    {
      review_type: 'gate',
      node_id: 'revert_patch',
      node_label: `回退补丁 #${patch_id}`,
      output_preview: `回退补丁 #${patch_id}（${reason || '未说明原因'}）`,
    },
    pipeline._policy,
  );
  if (approval.decision === DECISION_REJECT || approval.decision === DECISION_TERMINATE) {
    return new PatchOutcome({
      decision: approval.decision,
      status: AUDIT_STATUS_REJECTED,
      reason: approval.reason ?? '回退审批未通过',
    });
  }
  const last = await pipeline.chain.last_patch();
  // 审批批准后、落回退前复验：审批异步挂起期间链可能已前进（他方落链），
  // 链尾不再是我们批准的补丁——直接 revert_to 会回退到错误的版本语义。
  current = await pipeline.chain.current_version();
  if (patch_id !== current) {
    const reasonMsg = `回退冲突: 审批等待期间链已前进（目标 #${patch_id}，`
      + `当前链尾 #${current}）——请基于最新链尾重新发起回退`;
    // 批准动作不可无记录：冲突留痕（含 last_patch 摘要）
    await pipeline._put_record(_SET_AUDIT_COLLECTION, pipeline._audit_key(), {
      kind: 'revert',
      patch_id,
      reason,
      decision: approval.decision,
      round_id,
      last_patch: last,
      status: AUDIT_STATUS_CONFLICT,
      conflict_reason: reasonMsg,
      created_at: pipeline._created_at(),
    });
    return new PatchOutcome({
      decision: DECISION_REJECT,
      status: AUDIT_STATUS_CONFLICT,
      reason: reasonMsg,
    });
  }
  // 复验通过后落回退（expected_version CAS 兜底复验到写入间的读改写
  // 窗口——ENG1-8）
  await pipeline.chain.revert_to(targetVersion, current);
  // 回退后通知（活跃态回滚钩子）：失败须显式留痕——「审计说已回退但
  // 运行时态未回滚」的静默分叉不可闻。分两种审计状态：成功 = reverted；
  // 通知失败 = reverted_with_notify_error（补丁链已回退，活跃态回滚未
  // 生效——状态可观测，outcome 同步携带）
  let revertedStatus = AUDIT_STATUS_REVERTED;
  let notifyError: string | null = null;
  if (pipeline._on_reverted !== null) {
    try {
      const result = pipeline._on_reverted(patch_id, reason);
      if (isThenable(result)) await result;
    } catch (exc) {
      revertedStatus = AUDIT_STATUS_REVERTED_NOTIFY_FAILED;
      notifyError = String(exc);
    }
  }
  await pipeline._put_record(_SET_AUDIT_COLLECTION, pipeline._audit_key(), {
    kind: 'revert',
    patch_id,
    base_version: targetVersion,
    reason,
    decision: approval.decision,
    round_id,
    last_patch: last,
    status: revertedStatus,
    notify_error: notifyError,
    created_at: pipeline._created_at(),
  });
  return new PatchOutcome({
    patch_id,
    decision: approval.decision,
    status: revertedStatus,
    reason: notifyError !== null
      ? `${reason || '回退已落链'}；活跃态回滚失败: ${notifyError}`
      : (reason || null),
    applied: false,
  });
}
