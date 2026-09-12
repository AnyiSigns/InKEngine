/**
 * 受控演化应用层（P5-γ 单一受控通道：提案 → 目录校验 → 采纳前验证闸 →
 * 审批 → 补丁链/守卫写入 → 活跃目录换入）。
 *
 * 语义（执行模型 §五/§六）：作用域/通道/先验资产的增改下架全部走本通道——
 * 不依赖本管线的旁路直写由 GuardedStorage 拦截（channels:/org_priors:/
 * entities: 均为受守卫前缀），本层是**唯一**应用入口。步骤：
 *
 *   ① plan_evolution 目录感知校验（非法 = 拒绝，不产生副作用）；
 *   ② run_adoption_gate 采纳前验证闸（高影响变更先隔离试跑；未装配执行器
 *      fail-closed 阻断——P5-δ 注入真实试跑）；
 *   ③ approve_before_execute 审批卡（accept/auto 才放行；edit/reject/
 *      terminate = 拒绝，防半路改写绕过目录校验）；
 *   ④ 逐步骤执行：先 EvolutionWriter（补丁链 append → 实时守卫写 → 审计
 *      留痕），后活跃目录换入（失败不入目录，防内存与落盘分叉）。
 *
 * 下架 = 写 retired 标记记录（保留可审计/可回退）后移除活跃表；通道封禁 =
 * disabled 置位替换；先验覆盖 = org_priors 集合 upsert 行。全部副作用经
 * 注入 writer（测试用内存存储；宿主装配 GuardedStorage 包装的 writer）。
 */

import { approve_before_execute } from '../../gate/approval/approval.js';
import type {
  ApprovalInterruptContext,
  ApprovalOptions,
  InterruptPolicy,
} from '../../gate/approval/approval.js';
import type { EvolutionWriter } from '../../kernel/evolution_writer/_types.js';
import {
  channel_writer,
  entity_writer,
  org_prior_writer,
} from '../../kernel/evolution_writer/evolution_writer.js';
import { ChannelDirectory } from '../../model/channels/channel_directory.js';
import { EntityRegistry } from '../entities/entities.js';
import { org_priors_collection } from '../../model/scopes/prior_overlay.js';
import { channel_collection } from '../../model/channels/channel_directory.js';
import {
  run_adoption_gate,
  type AdoptionGateOptions,
  type AdoptionGateOutcome,
  type TrialRunner,
} from './adoption_gate.js';
import {
  plan_evolution,
  type ApplyPlanResult,
  type EvolutionPlanStep,
} from './apply_plan.js';
import type { EvolutionProposal, EvolutionProposalKind } from './evolution_proposal.js';

/** 应用层装配选项。 */
export interface ControlledEvolutionApplierInit {
  /** 活跃实体注册表（作用域资产目录；目录状态须已含出厂/宿主装配资产）。 */
  entities: EntityRegistry;
  /** 活跃通道目录。 */
  channels: ChannelDirectory;
  /** 演化写入器（三闸门管线；宿主可包装 GuardedStorage）。 */
  writer: EvolutionWriter;
  /** 通道资产落盘集合（缺省 = channel_collection('-')）。 */
  channelCollection?: string;
  /** 组织先验覆盖落盘集合（缺省 = org_priors_collection('-')）。 */
  priorCollection?: string;
  /** 审批策略钩子（缺省 = 全挂起——最保守；宿主注入直过名单）。 */
  approvalPolicy?: InterruptPolicy | null;
  /** 审批姿态（auto/review/deny；缺省 review，与产品姿态同语义）。 */
  pose?: string | null;
  /** 审批时钟（approval 超时判定；缺省 = 确定性 0）。 */
  clock?: (() => number) | null;
  /** 隔离试跑执行器（缺省 = 未装配；高影响提案强制先闸即 fail-closed）。 */
  trialRunner?: TrialRunner | null;
  /** 采纳前验证闸规则（缺省 = adoption_gate 定稿闸线）。 */
  gateOptions?: AdoptionGateOptions;
}

/** 单次提案应用报告（审批/闸/落步骤逐项可审计）。 */
export interface EvolutionApplyReport {
  status: 'applied' | 'invalid' | 'gate_blocked' | 'approval_rejected' | 'write_failed';
  kind: EvolutionProposalKind;
  violations: string[];
  gate: AdoptionGateOutcome | null;
  approval: { decision: string; source: string; reason: string | null } | null;
  steps_applied: number;
  detail: string;
}

const APPLY_NOTE_PREFIX = '受控演化';

/** 应用层：受控演化提案的审批 + 闸 + 落盘编排（自足；目录/写入器注入）。 */
export class ControlledEvolutionApplier {
  readonly entities: EntityRegistry;
  readonly channels: ChannelDirectory;
  readonly writer: EvolutionWriter;
  readonly channelCollection: string;
  readonly priorCollection: string;
  readonly approvalPolicy: InterruptPolicy | null;
  readonly pose: string | null;
  readonly clock: (() => number) | null;
  readonly trialRunner: TrialRunner | null;
  readonly gateOptions: AdoptionGateOptions;

  constructor(init: ControlledEvolutionApplierInit) {
    this.entities = init.entities;
    this.channels = init.channels;
    this.writer = init.writer;
    this.channelCollection = init.channelCollection ?? channel_collection();
    this.priorCollection = init.priorCollection ?? org_priors_collection();
    this.approvalPolicy = init.approvalPolicy ?? null;
    this.pose = init.pose ?? null;
    this.clock = init.clock ?? null;
    this.trialRunner = init.trialRunner ?? null;
    this.gateOptions = init.gateOptions ?? {};
  }

  /** 审批挂卡 key（来源 + 种类；宿主策略可按前缀直过/加时）。 */
  approval_key(kind: EvolutionProposalKind): string {
    return `evolution_apply:${kind}`;
  }

  /** 应用提案（ctx = 审批中断上下文；trialRunner 可单次覆写装配值）。 */
  async apply(
    ctx: ApprovalInterruptContext,
    proposal: EvolutionProposal,
    options: { trialRunner?: TrialRunner | null } = {},
  ): Promise<EvolutionApplyReport> {
    const plan: ApplyPlanResult = plan_evolution(proposal, {
      entities: this.entities,
      channels: this.channels,
    });
    if (!plan.ok) {
      return {
        status: 'invalid',
        kind: proposal.kind,
        violations: plan.violations,
        gate: null,
        approval: null,
        steps_applied: 0,
        detail: `提案未过目录校验: ${plan.violations.join('；')}`,
      };
    }
    const gate = await run_adoption_gate(proposal, {
      seam: options.trialRunner ?? this.trialRunner,
      ...this.gateOptions,
    });
    if (gate.blocked) {
      return {
        status: 'gate_blocked',
        kind: proposal.kind,
        violations: [],
        gate,
        approval: null,
        steps_applied: 0,
        detail: gate.block_reason ?? '采纳前验证闸阻断',
      };
    }
    const action = this._action(proposal);
    const approvalOptions: ApprovalOptions = {};
    if (this.clock !== null) approvalOptions.clock = this.clock;
    if (this.pose !== null) approvalOptions.pose = this.pose;
    const decision = await approve_before_execute(
      ctx,
      this.approval_key(proposal.kind),
      action,
      this._card(proposal),
      this.approvalPolicy,
      approvalOptions,
    );
    if (decision.decision !== 'accept' && decision.decision !== 'auto') {
      return {
        status: 'approval_rejected',
        kind: proposal.kind,
        violations: [],
        gate,
        approval: { decision: decision.decision, source: decision.source, reason: decision.reason },
        steps_applied: 0,
        detail: decision.reason ?? `审批决议 ${decision.decision}（非 accept/auto，不应用）`,
      };
    }
    let stepsApplied = 0;
    let failed: string | null = null;
    for (const step of plan.steps) {
      try {
        await this._execute_step(step, proposal);
        stepsApplied += 1;
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (failed !== null) {
      return {
        status: 'write_failed',
        kind: proposal.kind,
        violations: [],
        gate,
        approval: { decision: decision.decision, source: decision.source, reason: null },
        steps_applied: stepsApplied,
        detail: `落盘失败（已应用 ${stepsApplied}/${plan.steps.length} 步）: ${failed}`,
      };
    }
    return {
      status: 'applied',
      kind: proposal.kind,
      violations: [],
      gate,
      approval: { decision: decision.decision, source: decision.source, reason: null },
      steps_applied: stepsApplied,
      detail: `应用 ${proposal.kind} 完成（${stepsApplied} 步）`,
    };
  }

  /** 单步骤执行：先 writer 落盘，后活跃目录换入（失败不换入）。 */
  private async _execute_step(step: EvolutionPlanStep, proposal: EvolutionProposal): Promise<void> {
    const note = `${APPLY_NOTE_PREFIX}:${proposal.kind}（${proposal.rationale || '无理由说明'}）`;
    if (step.op === 'register_scope' || step.op === 'replace_scope') {
      await entity_writer(
        this.writer,
        this.entities.collection,
        step.spec.id,
        step.spec.to_dict(),
        { note },
      );
      if (step.op === 'register_scope') this.entities.register(step.spec);
      else this.entities.replace(step.spec);
      return;
    }
    if (step.op === 'retire_scope') {
      await entity_writer(this.writer, this.entities.collection, step.spec.id, step.record, { note });
      this.entities.unregister(step.spec.id);
      return;
    }
    if (step.op === 'register_channel') {
      await channel_writer(
        this.writer,
        this.channelCollection,
        step.spec.id,
        step.spec.to_dict(),
        { note },
      );
      this.channels.register(step.spec);
      return;
    }
    if (step.op === 'replace_channel' || step.op === 'seal_channel') {
      await channel_writer(
        this.writer,
        this.channelCollection,
        step.spec.id,
        step.spec.to_dict(),
        { note },
      );
      this.channels.replace(step.spec);
      return;
    }
    // upsert_prior
    await org_prior_writer(
      this.writer,
      this.priorCollection,
      step.overlay.id,
      step.overlay.to_dict(),
      { note },
    );
  }

  /** 审批动作形态（渲染与策略分级判定用）。 */
  private _action(proposal: EvolutionProposal): Record<string, unknown> {
    return {
      tool: `apply_evolution:${proposal.kind}`,
      kind: proposal.kind,
      summary: proposal.rationale || `应用受控演化提案 ${proposal.kind}`,
      payload: proposal.payload,
      provenance: proposal.provenance,
    };
  }

  /** 审批卡负载（前端按此渲染：种类/来源/理由/载荷预览）。 */
  private _card(proposal: EvolutionProposal): Record<string, unknown> {
    return {
      review_type: 'gate',
      node_id: `apply_evolution:${proposal.kind}`,
      node_label: '受控演化应用',
      output_preview:
        `种类: ${proposal.kind}（来源: ${proposal.provenance}）\n`
        + `理由: ${proposal.rationale || '（未说明）'}\n`
        + `载荷: ${JSON.stringify(proposal.payload)}`,
      evolution: {
        kind: proposal.kind,
        provenance: proposal.provenance,
        confidence: proposal.confidence,
        evidence: proposal.evidence,
      },
    };
  }
}
