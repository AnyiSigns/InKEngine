/**
 * 单次提案的处理结果与活跃态应用目标协议（core/self_application.py
 * PatchOutcome / ApplyTarget 移植）。
 *
 * PatchOutcome = 单次提案的处理结果（决议/落链/应用状态）；ApplyTarget =
 * 活跃态应用目标协议（宿主注册：补丁落链后的运行时生效钩子，幂等可重放）。
 */

import {
  AUDIT_STATUS_REJECTED,
} from './constants.js';
import { DECISION_REJECT } from '../approval/approval.js';

/** PatchOutcome 构造选项（对应 Python frozen dataclass 字段）。 */
export interface PatchOutcomeInit {
  /** 补丁版本号（批准落链后；未落链 = null）。 */
  patch_id?: number | null;
  /** 审批决议（accept/auto/edit/reject/terminate）。 */
  decision?: string;
  /** 处理状态（applied/rejected/conflict/invalid/reverted/pending）。 */
  status?: string;
  /** 拒绝/冲突/非法原因（展示与留痕）。 */
  reason?: string | null;
  /** 是否已生效（落链且目标应用成功）。 */
  applied?: boolean;
  /** 活跃态应用失败原因（链已落但运行时未生效；null = 应用成功或无目标钩子）。 */
  apply_error?: string | null;
}

/**
 * 单次提案的处理结果（frozen dataclass 镜像：构造后不可变）。
 *
 * apply_error 语义：链已落但活跃态应用失败——审计载荷同步携带，
 * 「链已落」与「运行时未生效」明确区分，不默认为成功。
 */
export class PatchOutcome {
  readonly patch_id: number | null;
  readonly decision: string;
  readonly status: string;
  readonly reason: string | null;
  readonly applied: boolean;
  readonly apply_error: string | null;

  constructor(init: PatchOutcomeInit = {}) {
    this.patch_id = init.patch_id ?? null;
    this.decision = init.decision ?? DECISION_REJECT;
    this.status = init.status ?? AUDIT_STATUS_REJECTED;
    this.reason = init.reason ?? null;
    this.applied = init.applied ?? false;
    this.apply_error = init.apply_error ?? null;
    Object.freeze(this);
  }
}

/**
 * 活跃态应用目标协议（宿主注册：补丁落链后的运行时生效钩子）。
 *
 * 钩子按补丁类型注册（如 ui → 更新渲染器数据源；tool → 注册进
 * 工具表；event_type → 事件类型注册表登记）；幂等可重放——重启
 * 装配从链组装恢复活跃态，不依赖钩子重放。
 */
export interface ApplyTarget {
  readonly name: string;
  apply(payload: Record<string, unknown>, patch_id: number): Promise<void>;
}
