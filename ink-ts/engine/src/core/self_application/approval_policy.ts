/**
 * 补丁审批策略适配（core/self_application.py _PatchApprovalPolicy 移植）。
 *
 * 宿主策略（``host.interrupt_policy()``）是审批闸门的单一来源（直过
 * 白名单/超时窗口归宿主），但其键命名按宿主语义（工具名/动作键），与
 * 补丁审批键命名空间（``patch:<kind>`` / ``revert:<id>``）不重叠——把
 * 宿主策略原样用于补丁审批会让分级表的 L0「策略直过」整体失效（低风险
 * 补丁也弹卡）。本适配器合成两套语义：
 *
 * - 分级表 L0 键：直过（不弹卡）；
 * - 其余键（含 revert）：交宿主策略判定——宿主/用户配置的
 *   ``auto_approve_keys`` 对补丁审批同样生效；
 * - 超时窗口：一律取宿主策略（宿主掌握挂起窗口）。
 *
 * 宿主策略抛异常 = fail-closed（按需审批 + 缺省超时窗口），不静默直过
 * （TS core 零 IO：logging.warning 属可观测性副作用，不落）。
 */

import type { InterruptPolicy } from '../approval/approval.js';
import { APPROVAL_TIMEOUT_SECONDS } from './approval_level.js';

export class _PatchApprovalPolicy implements InterruptPolicy {
  private readonly _inner: InterruptPolicy;
  private readonly _auto: ReadonlySet<string>;

  constructor(inner: InterruptPolicy, auto_approve_keys: ReadonlySet<string>) {
    this._inner = inner;
    this._auto = new Set<string>(auto_approve_keys);
  }

  /** 被包装的宿主策略（观察侧；宿主自持语义不被改写）。 */
  get inner(): InterruptPolicy {
    return this._inner;
  }

  should_approve(key: string, action: Record<string, unknown>): boolean {
    if (this._auto.has(key)) return false;
    try {
      return Boolean(this._inner.should_approve(key, action));
    } catch {
      // 宿主策略判定异常 = fail-closed 按需审批
      return true;
    }
  }

  timeout_for(key: string, action: Record<string, unknown>): number | null {
    try {
      return this._inner.timeout_for(key, action);
    } catch {
      // 宿主策略超时窗口取用异常 = 回落默认窗口
      return APPROVAL_TIMEOUT_SECONDS;
    }
  }
}
