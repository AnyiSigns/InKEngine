/**
 * 自指应用管线（core/self_application.py SelfApplicationPipeline 移植）：
 * 提案 → 校验 → 分级审批 → 落链 → 应用 → 审计。
 *
 * 装配（依赖注入）：storage（集补丁链后盾）、validator（按类型校验）、
 * policy（审批策略，L0 = auto_approve_keys 白名单）、分级表（kind →
 * L0/L1/L2）、l2_vetting（L2 的沙箱验证钩子）、targets（活跃态应用
 * 目标注册表）。
 *
 * 实现按 ≤350 行纪律拆分（同 Python 类/机制边界）：
 * - pipeline：SelfApplicationPipeline 类壳（装配/审计/审批卡构造等内部
 *   面，apply/revert 委托机制函数，公开形态与 Python 类一致）；
 * - apply_flow：apply 机制（校验 → 冲突 → 分级审批 → 回归 → 复验 → 落链
 *   → 活跃态应用 → 审计）；
 * - revert_flow：revert 机制（链尾限定 + 审批 + 复验 → 链级回退 → 回退后
 *   通知 → 审计）。
 *
 * TS seam 差异：created_at/审计键为注入时间源与键源（缺省确定值：时间 0、
 * 键自增 hex——core 零时钟零随机可复现，Python time.time/uuid 副作用的
 * 确定性替代）。
 */

import type { Storage } from '../storage/storage.js';
import type { ApplyTarget, PatchOutcome } from './patch_outcome.js';
import type {
  ApprovalDecision,
  ApprovalInterruptContext,
  InterruptPolicy,
} from '../approval/approval.js';
import { DefaultInterruptPolicy } from '../approval/approval.js';
import { ProposalValidator, SelfProposal } from '../self_proposal/index.js';
import type { PatchKind } from '../self_proposal/index.js';

import { run_apply } from './apply_flow.js';
import { run_revert } from './revert_flow.js';
import {
  APPROVAL_TIMEOUT_SECONDS,
  ApprovalLevel,
  DEFAULT_APPROVAL_LEVELS,
  type L2VettingHook,
} from './approval_level.js';
import { _APPROVAL_KEY_PREFIX, _SET_AUDIT_COLLECTION } from './constants.js';
import { _PatchApprovalPolicy } from './approval_policy.js';
import { GuardedStorage } from './guarded_storage.js';
import { SetPatchChain } from './set_patch_chain.js';

/** 回退后通知钩子（活跃态回滚；同步或异步结果均可，须 await 时自动 await）。 */
export type OnRevertedHook = (patch_id: number, reason: string) => unknown;

/** 域内回归钩子（演化不倒退闸门；返回真值 = 样例集全绿）。 */
export type RegressionHook = (proposal: SelfProposal) => unknown;

/** 审计写入选项（_audit 关键字参数镜像）。 */
export interface AuditOptions {
  status: string;
  reason?: string | null;
  decision?: string;
  patch_id?: number | null;
  round_id?: string | null;
  apply_error?: string | null;
}

/** SelfApplicationPipeline 构造选项（对应 Python keyword-only 装配参数）。 */
export interface SelfApplicationPipelineInit {
  storage: Storage;
  validator?: ProposalValidator | null;
  interrupt_policy?: InterruptPolicy | null;
  policy?: InterruptPolicy | null;
  approval_levels?: Partial<Record<PatchKind, ApprovalLevel>> | null;
  l2_vetting?: L2VettingHook | null;
  on_reverted?: OnRevertedHook | null;
  guard_token?: string | null;
  regression?: RegressionHook | null;
  /** 时间源（等价 Python time.time）；缺省确定值 0。 */
  now?: (() => number) | null;
  /** 审计键片段源（等价 uuid4().hex[:8]）；缺省自增确定 hex。 */
  audit_key_gen?: (() => string) | null;
}

/** 缺省审计键源：自增 8 位 hex（同秒多记录不冲突，确定可复现）。 */
const defaultAuditKeyGen = (): string => {
  defaultAuditKeyGenCounter += 1;
  return defaultAuditKeyGenCounter.toString(16).padStart(8, '0');
};
let defaultAuditKeyGenCounter = 0;

/** apply/revert 公共选项（round_id 透传审计）。 */
export interface ApplyOptions {
  round_id?: string | null;
}

export interface RevertOptions {
  reason?: string;
  round_id?: string | null;
}

export class SelfApplicationPipeline {
  /** 集补丁链（装配可见：宿主经此组装集状态/取当前版本）。 */
  readonly chain: SetPatchChain;

  /** 按类型校验器（提案校验入口；propose 阶段复用，零冗余）。 */
  readonly validator: ProposalValidator;

  // ── 内部面（下划线成员 = 装配期注入/运行期推导的内部状态与方法，
  //    按 Python 下划线约定非公开 API；apply/revert 机制函数经此协作，
  //    拆文件是 ≤350 行纪律的类级拆分，非跨模块语义泄露）──
  readonly _storage: Storage;
  readonly _guard_token: string | null;
  readonly _policy: InterruptPolicy;
  readonly _levels: Readonly<Partial<Record<PatchKind, ApprovalLevel>>>;
  readonly _l2_vetting: L2VettingHook | null;
  readonly _on_reverted: OnRevertedHook | null;
  readonly _regression: RegressionHook | null;
  readonly _targets: Partial<Record<PatchKind, ApplyTarget>>;
  readonly _now_fn: () => number;
  readonly _audit_key_gen: () => string;

  constructor(init: SelfApplicationPipelineInit) {
    const { storage } = init;
    this.chain = new SetPatchChain(storage, { guard_token: init.guard_token ?? null });
    this._storage = storage;
    this._guard_token = init.guard_token ?? null;
    this.validator = init.validator ?? new ProposalValidator();
    // 审批分级（kind → L0/L1/L2）：L0 推导为「自动批准键」注入默认策略；
    // L1 弹卡；L2 沙箱验证后弹卡。审批策略 = 宿主注入优先（宿主直过
    // 白名单/超时窗口对补丁审批同样生效）；未注入时按 L0 分级自建默认
    // 策略。``policy`` 为历史形参别名，二者并存以 interrupt_policy 为准。
    this._levels = { ...(init.approval_levels ?? DEFAULT_APPROVAL_LEVELS) };
    const autoKeys = new Set<string>(
      (Object.entries(this._levels) as [PatchKind, ApprovalLevel][])
        .filter(([, level]) => level === ApprovalLevel.L0)
        .map(([kind]) => `${_APPROVAL_KEY_PREFIX}:${kind}`),
    );
    const hostPolicy = init.interrupt_policy ?? init.policy ?? null;
    if (hostPolicy !== null) {
      // L0 键直过 + 其余键交宿主策略（适配器合成两套语义）
      this._policy = new _PatchApprovalPolicy(hostPolicy, autoKeys);
    } else {
      this._policy = new DefaultInterruptPolicy(autoKeys, new Set<string>(), APPROVAL_TIMEOUT_SECONDS);
    }
    this._l2_vetting = init.l2_vetting ?? null;
    this._on_reverted = init.on_reverted ?? null;
    this._regression = init.regression ?? null;
    this._targets = {};
    this._now_fn = init.now ?? (() => 0);
    this._audit_key_gen = init.audit_key_gen ?? defaultAuditKeyGen;
  }

  /** 注册活跃态应用目标（同名覆盖 = 宿主按配置装配）。 */
  register_target(kind: PatchKind, target: ApplyTarget): void {
    this._targets[kind] = target;
  }

  /** 审批挂卡 key（patch:<kind>；revert 键 = revert:<id>）。 */
  approval_key(kind: PatchKind): string {
    return `${_APPROVAL_KEY_PREFIX}:${kind}`;
  }

  /** 应用一条提案：校验 → 冲突 → 分级审批 → 落链 → 应用 → 审计。 */
  async apply(
    ctx: ApprovalInterruptContext,
    proposal: SelfProposal,
    options: ApplyOptions = {},
  ): Promise<PatchOutcome> {
    return run_apply(this, ctx, proposal, options.round_id ?? null);
  }

  /** 回退指定补丁（仅链尾）：审批确认后落审计 + 链级回退。 */
  async revert(
    ctx: ApprovalInterruptContext,
    patch_id: number,
    options: RevertOptions = {},
  ): Promise<PatchOutcome> {
    return run_revert(this, ctx, patch_id, options.reason ?? '', options.round_id ?? null);
  }

  /** 集演化审计日志（append-only，按时间倒序；limit 截取尾部）。 */
  async audit_log(options: { limit?: number } = {}): Promise<Record<string, unknown>[]> {
    const limit = options.limit ?? 100;
    const records = await this._storage.list_records(_SET_AUDIT_COLLECTION);
    const ordered = [...records].sort(
      (a, b) => (Number(a['created_at'] ?? 0)) - Number(b['created_at'] ?? 0),
    );
    return limit > 0 ? ordered.slice(-limit) : [];
  }

  /** 链写入（守卫令牌透传规则与 SetPatchChain 一致；审计集合用）。 */
  async _put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void> {
    if (this._guard_token !== null && this._storage instanceof GuardedStorage) {
      await this._storage.put_record(collection, key, data, { guard_token: this._guard_token });
    } else {
      await this._storage.put_record(collection, key, data);
    }
  }

  /** 审批动作形态（渲染与策略分级判定用）。 */
  _build_action(proposal: SelfProposal): Record<string, unknown> {
    return {
      tool: `apply_patch:${proposal.kind}`,
      kind: proposal.kind,
      summary: proposal.rationale || `应用 ${proposal.kind} 补丁`,
      payload: proposal.payload,
      base_version: proposal.base_version,
    };
  }

  /** 审批卡负载（展示补丁类型/理由/payload 预览；前端按此渲染）。 */
  _build_card(proposal: SelfProposal): Record<string, unknown> {
    return {
      review_type: 'gate',
      node_id: `apply_patch:${proposal.kind}`,
      node_label: `应用${proposal.kind}补丁`,
      output_preview: `类型: ${proposal.kind}\n理由: ${proposal.rationale || '（未说明）'}`,
      patch: {
        kind: proposal.kind,
        payload: proposal.payload,
        base_version: proposal.base_version,
      },
    };
  }

  /** 编辑决议内容落地：重新过校验，通过才采用（不半途落链）。 */
  _resolve_edited(
    approval: ApprovalDecision,
    proposal: SelfProposal,
  ): SelfProposal | null {
    const edited = approval.edited_content;
    if (edited === null || typeof edited !== 'object' || Array.isArray(edited)) {
      return null;
    }
    const reworked = new SelfProposal({
      kind: proposal.kind,
      payload: edited as Record<string, unknown>,
      base_version: proposal.base_version,
      rationale: proposal.rationale,
      meta: proposal.meta,
    });
    if (this.validator.validate(reworked).length > 0) return null;
    return reworked;
  }

  /** 当前时间（注入时间源；审计记录 created_at 用）。 */
  _created_at(): number {
    return this._now_fn();
  }

  /** 审计记录键：键片段源（同秒多记录不冲突）。 */
  _audit_key(): string {
    return this._audit_key_gen();
  }

  /**
   * 落审计记录（append-only，历史不撒谎）。apply_error 非 None 时记录
   * 活跃态应用失败（链已落但运行时未生效——「链已落」与「运行时生效」
   * 在审计中明确区分，不默认为成功）。
   */
  async _audit(
    proposal: SelfProposal,
    options: AuditOptions,
  ): Promise<void> {
    const record: Record<string, unknown> = {
      kind: proposal.kind,
      patch_id: options.patch_id ?? null,
      base_version: proposal.base_version,
      rationale: proposal.rationale,
      reason: options.reason ?? null,
      decision: options.decision ?? 'reject',
      status: options.status,
      round_id: options.round_id ?? null,
      payload: proposal.payload,
      meta: { ...proposal.meta },
      apply_error: options.apply_error ?? null,
      created_at: this._created_at(),
    };
    await this._put_record(_SET_AUDIT_COLLECTION, this._audit_key(), record);
  }
}
