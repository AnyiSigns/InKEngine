/**
 * 采纳前验证闸（隔离试跑 seam：提案 → trial_spec → 隔离试跑 → verdict →
 * 审批/应用）。
 *
 * 语义（执行模型 §四-②/§六 采纳前验证）：高影响资产变更（影响所有未来执行）
 * 在落地主执行**之前**先隔离试跑验证——试跑胜负不进主执行证据/组织档案，
 * 过闸才进审批/补丁链。本波只落**闸的判定数据流与纯规则**，不实现试跑执行
 * 器（P5-δ 落地）：TrialRunner 为注入 seam，未注入 + 闸要求 = fail-closed
 * 拒绝（宁拒勿放）。
 *
 * 强制规则（保守、确定性可测）：一切既有资产**变更**（update_scope /
 * retire_scope / update_channel / seal_channel / update_prior /
 * apply_shortcut / downrank）一律强制先闸——变更改写既有作用域/通道/先验
 * 定义即影响未来执行；**新增**资产（add_scope / add_channel）不改变既有
 * 行为，仅当来源非 user（agent 自演化 / 组织择优结晶）时才强制先闸——
 * 用户主动新增且经完整审批可直接放行。来源与种类之外的细化规则（如出厂
 * 素材变更的更高审批档）由装配/宿主按需收紧，本模块给默认闸线。
 */

import type { EvolutionProposal, EvolutionProposalKind } from './evolution_proposal.js';

/** 高影响种类（既有资产变更；一律强制采纳前验证）。 */
export const GATE_MANDATORY_KINDS: readonly EvolutionProposalKind[] = [
  'update_scope',
  'retire_scope',
  'update_channel',
  'seal_channel',
  'update_prior',
  'apply_shortcut',
  'downrank',
];

/** 新增类种类（不改变既有行为；仅非 user 来源强制先闸）。 */
export const GATE_ADDITIVE_KINDS: readonly EvolutionProposalKind[] = [
  'add_scope',
  'add_channel',
];

/** 试跑结论：pass = 过闸；fail/inconclusive = 不过闸（fail-closed 同判）。 */
export type TrialVerdict = 'pass' | 'fail' | 'inconclusive';

/** 试跑结论是否阻断（只有 pass 放行；inconclusive 视同失败——证据不足不
 *  能证明安全，宁拒勿放）。 */
export function verdict_blocks(verdict: TrialVerdict): boolean {
  return verdict !== 'pass';
}

/** 闸规则选项（host/装配可按需收紧；缺省 = 上面定稿闸线）。 */
export interface AdoptionGateOptions {
  /** 强制先闸的种类集（覆写；须包含全部既有资产变更类，防漏闸）。 */
  mandatoryKinds?: readonly EvolutionProposalKind[];
}

/** 采纳前验证要求判定结果（纯函数输出）。 */
export interface GateRequirement {
  required: boolean;
  reasons: string[];
}

/** 要求判定：既有资产变更 / 非 user 来源新增 = 强制先闸（fail-closed 基线）。 */
export function classify_gate_requirement(
  proposal: EvolutionProposal,
  options: AdoptionGateOptions = {},
): GateRequirement {
  const mandatory = options.mandatoryKinds ?? GATE_MANDATORY_KINDS;
  const reasons: string[] = [];
  if ((mandatory as readonly string[]).includes(proposal.kind)) {
    reasons.push(`${proposal.kind}：更改既有作用域/通道/先验定义，影响所有未来执行`);
  } else if (proposal.provenance !== 'user') {
    reasons.push(`${proposal.kind}：${proposal.provenance} 来源的新增资产须先隔离试跑验证`);
  }
  return { required: reasons.length > 0, reasons };
}

/** 试跑规格（隔离试跑执行器输入：要试跑什么 = 提案变更意图 + 证据）。 */
export interface TrialSpec {
  kind: EvolutionProposalKind;
  payload: Record<string, unknown>;
  rationale: string;
  confidence: number | null;
  evidence: Record<string, unknown>;
  provenance: string;
}

/** 试跑规格构造（纯函数；执行器据此在隔离子引擎中试跑该变更）。 */
export function trial_spec_for(proposal: EvolutionProposal): TrialSpec {
  return {
    kind: proposal.kind,
    payload: { ...proposal.payload },
    rationale: proposal.rationale,
    confidence: proposal.confidence,
    evidence: { ...proposal.evidence },
    provenance: proposal.provenance,
  };
}

/** 隔离试跑执行器 seam（P5-δ 落地真实执行；本波只定义契约）。 */
export interface TrialRunner {
  run_trial(spec: TrialSpec): Promise<TrialVerdict>;
}

/** 闸判定产出（应用管线据此决定放行/阻断）。 */
export interface AdoptionGateOutcome {
  /** 是否要求先闸（false = 直达审批通道）。 */
  required: boolean;
  /** 是否被闸阻断（true = 不得进审批/应用）。 */
  blocked: boolean;
  block_reason: string | null;
  verdict: TrialVerdict | null;
  spec: TrialSpec | null;
}

/**
 * 采纳前验证闸执行（数据流编排）：非强制 → 放行（直接进审批）；强制 →
 * 装配 seam 试跑（未装配 = fail-closed 阻断）；verdict=pass → 放行，其余
 * 阻断。纯数据流 + 注入 seam，试跑证据不入本流程之外任何档案。
 */
export async function run_adoption_gate(
  proposal: EvolutionProposal,
  options: AdoptionGateOptions & { seam?: TrialRunner | null },
): Promise<AdoptionGateOutcome> {
  const requirement = classify_gate_requirement(proposal, options);
  if (!requirement.required) {
    return { required: false, blocked: false, block_reason: null, verdict: null, spec: null };
  }
  const spec = trial_spec_for(proposal);
  const seam = options.seam ?? null;
  if (seam === null) {
    return {
      required: true,
      blocked: true,
      block_reason:
        `${proposal.kind}：高影响资产变更须先隔离试跑验证，但未装配试跑执行器` +
        '（fail-closed 拒绝，防止演化裸奔上线）',
      verdict: null,
      spec,
    };
  }
  const verdict = await seam.run_trial(spec);
  const blocked = verdict_blocks(verdict);
  return {
    required: true,
    blocked,
    block_reason: blocked
      ? `隔离试跑未通过（${verdict}）：试跑胜负不进主执行证据/组织档案`
      : null,
    verdict,
    spec,
  };
}
