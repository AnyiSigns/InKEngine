/**
 * 应用机制函数（core/self_application.py SelfApplicationPipeline.apply
 * 移植；由 SelfApplicationPipeline.apply 委托，≤350 行类级拆分）。
 *
 * 决议语义（对齐 approval 机制）：
 * - accept/auto：落链并应用；
 * - edit：edited_content 作为新 payload **重新过一遍校验**，通过才落链
 *   （失败 = 拒绝并留痕，不半途落链）；
 * - reject/terminate：拒绝并留痕（fail-closed 方向）。
 */

import type { ApprovalInterruptContext } from '../approval/approval.js';
import {
  approve_before_execute,
  DECISION_EDIT,
  DECISION_REJECT,
  DECISION_TERMINATE,
} from '../approval/approval.js';
import { GraphDefinitionError } from '../errors.js';
import type { Patch } from '../patch/patchChain.js';
import type { SelfProposal } from '../self_proposal/index.js';

import { ApprovalLevel } from './approval_level.js';
import {
  AUDIT_STATUS_APPLIED,
  AUDIT_STATUS_CONFLICT,
  AUDIT_STATUS_INVALID,
  AUDIT_STATUS_REJECTED,
} from './constants.js';
import { PatchOutcome } from './patch_outcome.js';
import { patch_path } from './patch_path.js';
import type { SelfApplicationPipeline } from './pipeline.js';

/**
 * 应用一条提案：① 形态校验 → ② 并发冲突 → ③ 分级审批（L0 直过 /
 * L1 弹卡 / L2 沙箱验证）→ 域内回归 → ④ 落链前复验 → ⑤ 落链 →
 * ⑥ 活跃态应用 → 审计。
 */
export async function run_apply(
  pipeline: SelfApplicationPipeline,
  ctx: ApprovalInterruptContext,
  proposal: SelfProposal,
  round_id: string | null,
): Promise<PatchOutcome> {
  // ① 形态校验：非法 payload 在闸门口拒绝（不挂卡不落链）
  const violations = pipeline.validator.validate(proposal);
  if (violations.length > 0) {
    const reason = violations.join('；');
    await pipeline._audit(proposal, { status: AUDIT_STATUS_INVALID, reason, round_id });
    return new PatchOutcome({ decision: DECISION_REJECT, status: AUDIT_STATUS_INVALID, reason });
  }
  // ② 并发冲突：基准版本 ≠ 当前版本 = 拒绝并要求基于最新态重提
  let current = await pipeline.chain.current_version();
  if (proposal.base_version !== current) {
    const reason = `并发冲突: 提案基于版本 ${proposal.base_version}，`
      + `当前版本 ${current}——请基于最新集状态重提`;
    await pipeline._audit(proposal, { status: AUDIT_STATUS_CONFLICT, reason, round_id });
    return new PatchOutcome({ decision: DECISION_REJECT, status: AUDIT_STATUS_CONFLICT, reason });
  }
  // ③ 分级审批：L0 直过（策略 auto_approve_keys）/ L1 弹卡 / L2 沙箱
  //    验证通过后才弹卡。L2 未装配验证钩子 = 显式拒绝（fail-closed——
  //    L2 的沙箱验证不是可选项，缺验证不静默降级）
  const level = pipeline._levels[proposal.kind] ?? ApprovalLevel.L1;
  if (level === ApprovalLevel.L2) {
    if (pipeline._l2_vetting === null) {
      const reason = `L2 沙箱验证未装配（${proposal.kind} 补丁须人工验证）`;
      // 配方漏注 vetting_l2_hook 时 L2 提案一律拒绝（fail-closed 保留），
      // 但只留审计不可闻——装配缺陷表现为「AI 提案全被拒」的静默现象，
      // 宿主侧须显式检查配方装配（core 零 IO 不留日志）
      await pipeline._audit(proposal, { status: AUDIT_STATUS_REJECTED, reason, round_id });
      return new PatchOutcome({ decision: DECISION_REJECT, status: AUDIT_STATUS_REJECTED, reason });
    }
    const vettingViolations = pipeline._l2_vetting(proposal);
    if (vettingViolations.length > 0) {
      const reason = `L2 沙箱验证未通过: ${vettingViolations.join('；')}`;
      await pipeline._audit(proposal, { status: AUDIT_STATUS_REJECTED, reason, round_id });
      return new PatchOutcome({ decision: DECISION_REJECT, status: AUDIT_STATUS_REJECTED, reason });
    }
  }
  const action = pipeline._build_action(proposal);
  const approval = await approve_before_execute(
    ctx,
    pipeline.approval_key(proposal.kind),
    action,
    pipeline._build_card(proposal),
    pipeline._policy,
  );
  if (approval.decision === DECISION_REJECT || approval.decision === DECISION_TERMINATE) {
    const reason = approval.reason ?? '审批未通过';
    await pipeline._audit(proposal, {
      status: AUDIT_STATUS_REJECTED,
      reason,
      decision: approval.decision,
      round_id,
    });
    return new PatchOutcome({ decision: approval.decision, status: AUDIT_STATUS_REJECTED, reason });
  }
  if (approval.decision === DECISION_EDIT) {
    const edited = pipeline._resolve_edited(approval, proposal);
    if (edited === null) {
      const reason = '编辑决议内容非法（重新校验未通过），未落链';
      await pipeline._audit(proposal, {
        status: AUDIT_STATUS_REJECTED,
        reason,
        decision: DECISION_EDIT,
        round_id,
      });
      return new PatchOutcome({ decision: DECISION_EDIT, status: AUDIT_STATUS_REJECTED, reason });
    }
    proposal = edited;
  }
  // 域内回归（演化不倒退）：知识/工具/规则补丁落链前跑既有样例集，
  // 不通过 = 拒绝并留痕（fail-closed 方向；默认未装配则透传）
  if (
    pipeline._regression !== null
    && (proposal.kind === 'knowledge' || proposal.kind === 'tool' || proposal.kind === 'rule')
  ) {
    let passed = false;
    let reason = '';
    try {
      passed = Boolean(await pipeline._regression(proposal));
    } catch (exc) {
      passed = false;
      reason = `域内回归执行异常: ${String(exc)}`;
    }
    if (!passed && reason === '') {
      reason = '域内回归未通过（样例集不全绿，演化不倒退闸门拒绝）';
    }
    if (!passed) {
      await pipeline._audit(proposal, {
        status: AUDIT_STATUS_REJECTED,
        reason,
        decision: approval.decision,
        round_id,
      });
      return new PatchOutcome({ decision: DECISION_REJECT, status: AUDIT_STATUS_REJECTED, reason });
    }
  }
  // ④ 落链前复验并发基准：审批（L1 弹卡等）可能异步挂起，期间链可能已
  //    被其他提案推进——基于过期基准落链会静默覆盖等待期内已批准的变更。
  current = await pipeline.chain.current_version();
  if (proposal.base_version !== current) {
    const reason = `并发冲突: 审批等待期间集已前进（提案基于版本 `
      + `${proposal.base_version}，当前 ${current}）——请基于最新集状态重提`;
    await pipeline._audit(proposal, {
      status: AUDIT_STATUS_CONFLICT,
      reason,
      decision: approval.decision,
      round_id,
    });
    return new PatchOutcome({ decision: DECISION_REJECT, status: AUDIT_STATUS_CONFLICT, reason });
  }
  // ⑤ 落链（单次存储事务 + 乐观版本 CAS：复验后到实际写入间的读改写
  //    窗口由 append 的 expected_version 二次校验兜底——ENG1-8）
  let patch_id: number;
  try {
    const [path, value] = patch_path(proposal.kind, proposal.payload);
    const patch: Patch = { op: 'replace', path, value };
    patch_id = await pipeline.chain.append(patch, current);
  } catch (exc) {
    if (!(exc instanceof GraphDefinitionError)) throw exc;
    const reason = `落链失败: ${exc.message}`;
    await pipeline._audit(proposal, {
      status: AUDIT_STATUS_REJECTED,
      reason,
      decision: approval.decision,
      round_id,
    });
    return new PatchOutcome({ decision: approval.decision, status: AUDIT_STATUS_REJECTED, reason });
  }
  // ⑥ 活跃态应用（幂等钩子）：失败 = 链已落但运行时未生效，审计显式
  //    区分（apply_error），重启装配从链恢复
  const target = pipeline._targets[proposal.kind];
  let applyError: string | null = null;
  if (target !== undefined) {
    try {
      await target.apply(proposal.payload, patch_id);
    } catch (exc) {
      applyError = String(exc);
    }
  }
  await pipeline._audit(proposal, {
    status: AUDIT_STATUS_APPLIED,
    patch_id,
    decision: approval.decision,
    round_id,
    apply_error: applyError,
  });
  return new PatchOutcome({
    patch_id,
    decision: approval.decision,
    status: AUDIT_STATUS_APPLIED,
    applied: true,
    apply_error: applyError,
  });
}
