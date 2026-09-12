/**
 * 受控演化提案数据面（P5-γ：增/改/下架作用域、改/封通道、先验更新、
 * 短路化、降权的统一提案形态）。
 *
 * 一条提案 = 目标种类（kind）+ 载荷（payload）+ 置信度/证据（择优来源，
 * 可选）+ 来源（provenance：user / agent_self / org_pruning）+ 理由。
 * 提案只是**变更意图的声明**：目录感知的校验（目标存在性/形态冲突）在
 * 应用计划层（apply_plan.ts）做；结构层只保证「载荷形态与该 kind 匹配」。
 *
 * kind 词表与 Wave-1/2 数据面词汇同源：作用域资产 = 实体目录的带 scope 实体
 * （add/update/retire_scope，载荷 asset = EntitySpec dict）；通道资产 =
 * 通道条件目录（add/update/seal_channel，封 = disabled 置位）；组织先验覆盖
 * （update_prior / apply_shortcut / downrank，见 scopes/prior_overlay.ts）。
 * 不另立第二套枚举——作用域角色/通道形态/提交契约/审批档复用既有词表常量。
 *
 * 纯数据面（JSON 进 JSON 出）：构造即结构校验（fail-closed），可 to_dict/
 * from_dict 往返；执行语义零包含。
 */

import {
  CHANNEL_COMMITS,
  CHANNEL_SHAPES,
  type ChannelCommit,
  type ChannelShape,
} from '../../model/channels/channel_spec.js';
import { GraphDefinitionError } from '../../model/errors.js';
import { isRecord, typeName } from '../../model/json.js';

// ── 提案种类（词表 + 分组；无第二套枚举）──

export const EVOLUTION_KIND_ORDER = [
  'add_scope',
  'update_scope',
  'retire_scope',
  'add_channel',
  'update_channel',
  'seal_channel',
  'update_prior',
  'apply_shortcut',
  'downrank',
] as const;

export type EvolutionProposalKind = (typeof EVOLUTION_KIND_ORDER)[number];

/** 作用域资产类提案（add/update/retire 作用域）。 */
export const SCOPE_EVOLUTION_KINDS = ['add_scope', 'update_scope', 'retire_scope'] as const;
/** 通道资产类提案（add/update/封 通道）。 */
export const CHANNEL_EVOLUTION_KINDS = ['add_channel', 'update_channel', 'seal_channel'] as const;
/** 组织先验覆盖类提案（先验更新/短路/降权；持久化 = org_priors 覆盖行）。 */
export const PRIOR_EVOLUTION_KINDS = ['update_prior', 'apply_shortcut', 'downrank'] as const;

/** 是否作用域资产类提案（type guard：命中即收窄为 scope 种类联合）。 */
export function is_scope_kind(kind: string): kind is (typeof SCOPE_EVOLUTION_KINDS)[number] {
  return (SCOPE_EVOLUTION_KINDS as readonly string[]).includes(kind);
}

/** 是否通道资产类提案（type guard）。 */
export function is_channel_kind(kind: string): kind is (typeof CHANNEL_EVOLUTION_KINDS)[number] {
  return (CHANNEL_EVOLUTION_KINDS as readonly string[]).includes(kind);
}

/** 是否组织先验覆盖类提案（type guard）。 */
export function is_prior_kind(kind: string): kind is (typeof PRIOR_EVOLUTION_KINDS)[number] {
  return (PRIOR_EVOLUTION_KINDS as readonly string[]).includes(kind);
}

// ── 来源 ──

/** 用户发起（人工治理：直接意图，full approval 可直放）。 */
export const PROVENANCE_USER = 'user';
/** agent 自修改（agent-self 演化；一律经采纳前验证闸）。 */
export const PROVENANCE_AGENT = 'agent_self';
/** 组织择优（org_pruning 统计结晶；advisory 升格为受控变更）。 */
export const PROVENANCE_ORG = 'org_pruning';

export const EVOLUTION_PROVENANCES = [
  PROVENANCE_USER,
  PROVENANCE_AGENT,
  PROVENANCE_ORG,
] as const;

export type EvolutionProvenance = (typeof EVOLUTION_PROVENANCES)[number];

// ── 载荷结构校验（构造即执行；字段类型/取值非法 = 显式拒绝）──

function _need_string(payload: Record<string, unknown>, key: string, where: string): string | null {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return `${where} 缺 ${key}（非空字符串）`;
  }
  return null;
}

function _need_record(payload: Record<string, unknown>, key: string, where: string): string | null {
  const value = payload[key];
  if (!isRecord(value)) {
    return `${where} 缺 ${key}（dict）`;
  }
  return null;
}

/** downrank 载荷（择优模式降权；shape/commit 复用通道词表）。 */
export interface DownrankModeRef {
  from: string;
  to: string;
  shape: ChannelShape;
  commit: ChannelCommit;
}

/** 载荷结构校验（非法字段形态/取值 = 违规清单，可读可审计）。 */
export function payload_violations(
  kind: EvolutionProposalKind,
  payload: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const where = `${kind} 载荷`;
  if (!isRecord(payload)) return [`${where} 须为 dict，收到 ${typeName(payload)}`];
  if (kind === 'add_scope' || kind === 'update_scope') {
    const bad = _need_record(payload, 'asset', where);
    if (bad !== null) {
      out.push(bad);
    } else {
      const asset = payload['asset'] as Record<string, unknown>;
      const id = _need_string(asset, 'id', `${where}.asset`);
      if (id !== null) out.push(id);
      if (asset['scope'] === undefined || !isRecord(asset['scope'])) {
        out.push(`${where}.asset 缺 scope（作用域资产须携带作用域声明块）`);
      }
    }
    return out;
  }
  if (kind === 'retire_scope') {
    const bad = _need_string(payload, 'scope', where);
    if (bad !== null) out.push(bad);
    if (payload['reason'] !== undefined && typeof payload['reason'] !== 'string') {
      out.push(`${where}.reason 须为字符串`);
    }
    return out;
  }
  if (kind === 'add_channel' || kind === 'update_channel') {
    const bad = _need_record(payload, 'asset', where);
    if (bad !== null) {
      out.push(bad);
    } else {
      const asset = payload['asset'] as Record<string, unknown>;
      if (asset['id'] === undefined || typeof asset['id'] !== 'string' || (asset['id'] as string).trim() === '') {
        out.push(`${where}.asset 缺 id（非空字符串）`);
      }
      if (typeof asset['shape'] !== 'string' || !(CHANNEL_SHAPES as readonly string[]).includes(asset['shape'] as string)) {
        out.push(`${where}.asset.shape 非法（须为 ${CHANNEL_SHAPES.join('/')}）`);
      }
    }
    return out;
  }
  if (kind === 'seal_channel') {
    const bad = _need_string(payload, 'channel', where);
    if (bad !== null) out.push(bad);
    return out;
  }
  if (kind === 'update_prior') {
    const bad = _need_record(payload, 'pattern', where);
    if (bad !== null) out.push(bad);
    return out;
  }
  if (kind === 'apply_shortcut') {
    for (const key of ['from', 'to', 'skip_scope'] as const) {
      const bad = _need_string(payload, key, where);
      if (bad !== null) out.push(bad);
    }
    return out;
  }
  // downrank
  const bad = _need_record(payload, 'mode', where);
  if (bad !== null) {
    out.push(bad);
  } else {
    const mode = payload['mode'] as Record<string, unknown>;
    for (const key of ['from', 'to'] as const) {
      const bad2 = _need_string(mode, key, `${where}.mode`);
      if (bad2 !== null) out.push(bad2);
    }
    const shape = mode['shape'];
    if (typeof shape !== 'string' || !(CHANNEL_SHAPES as readonly string[]).includes(shape)) {
      out.push(`${where}.mode.shape 非法（须为 ${CHANNEL_SHAPES.join('/')}）`);
    }
    const commit = mode['commit'];
    if (typeof commit !== 'string' || !(CHANNEL_COMMITS as readonly string[]).includes(commit)) {
      out.push(`${where}.mode.commit 非法（须为 ${CHANNEL_COMMITS.join('/')}）`);
    }
  }
  const weight = payload['weight'];
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
    out.push(`${where}.weight 非法（须 (0,1] 内数值）`);
  }
  return out;
}

// ── 提案形态 ──

export interface EvolutionProposalInit {
  kind: EvolutionProposalKind;
  payload: Record<string, unknown>;
  provenance: EvolutionProvenance;
  /** 置信度 [0,1]（择优来源的证据强度；人工可省 = null）。 */
  confidence?: number | null;
  /** 证据摘要（择优统计/用户说明；纯透传记录）。 */
  evidence?: Record<string, unknown> | null;
  rationale?: string;
  meta?: Record<string, unknown>;
}

function _valid_confidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** 一条受控演化提案（冻结数据形态：kind + payload + 来源 + 证据）。 */
export class EvolutionProposal {
  readonly kind: EvolutionProposalKind;
  readonly payload: Record<string, unknown>;
  readonly provenance: EvolutionProvenance;
  readonly confidence: number | null;
  readonly evidence: Record<string, unknown>;
  readonly rationale: string;
  readonly meta: Record<string, unknown>;

  constructor(init: EvolutionProposalInit) {
    if (!(EVOLUTION_KIND_ORDER as readonly string[]).includes(init.kind)) {
      throw new GraphDefinitionError(
        `演化提案 kind 非法: ${String(init.kind)}（仅 ${EVOLUTION_KIND_ORDER.join('/')}）`,
      );
    }
    if (!(EVOLUTION_PROVENANCES as readonly string[]).includes(init.provenance)) {
      throw new GraphDefinitionError(
        `演化提案 provenance 非法: ${String(init.provenance)}（仅 ${EVOLUTION_PROVENANCES.join('/')}）`,
      );
    }
    const violations = payload_violations(init.kind, init.payload);
    if (violations.length > 0) {
      throw new GraphDefinitionError(`演化提案结构非法: ${violations.join('；')}`);
    }
    if (init.confidence !== undefined && init.confidence !== null && !_valid_confidence(init.confidence)) {
      throw new GraphDefinitionError(
        `演化提案 confidence 非法: ${String(init.confidence)}（须 [0,1] 或省略）`,
      );
    }
    this.kind = init.kind;
    this.payload = { ...init.payload };
    this.provenance = init.provenance;
    this.confidence = init.confidence ?? null;
    this.evidence = { ...(init.evidence ?? {}) };
    this.rationale = init.rationale ?? '';
    this.meta = { ...(init.meta ?? {}) };
    Object.freeze(this);
  }

  /** 载荷目标记录（scope/channel asset 类的 asset dict；其余 = null）。 */
  asset_record(): Record<string, unknown> | null {
    const asset = this.payload['asset'];
    return isRecord(asset) ? asset : null;
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      kind: this.kind,
      payload: this.payload,
      provenance: this.provenance,
    };
    if (this.confidence !== null) data['confidence'] = this.confidence;
    if (Object.keys(this.evidence).length > 0) data['evidence'] = { ...this.evidence };
    if (this.rationale) data['rationale'] = this.rationale;
    if (Object.keys(this.meta).length > 0) data['meta'] = { ...this.meta };
    return data;
  }

  static from_dict(data: unknown): EvolutionProposal {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`演化提案声明非法: 期望 dict，收到 ${typeName(data)}`);
    }
    const rawKind = data['kind'];
    if (typeof rawKind !== 'string' || !(EVOLUTION_KIND_ORDER as readonly string[]).includes(rawKind)) {
      throw new GraphDefinitionError(`演化提案 kind 非法: ${String(rawKind)}`);
    }
    const rawProvenance = data['provenance'];
    if (
      typeof rawProvenance !== 'string'
      || !(EVOLUTION_PROVENANCES as readonly string[]).includes(rawProvenance)
    ) {
      throw new GraphDefinitionError(`演化提案 provenance 非法: ${String(rawProvenance)}`);
    }
    const payload = data['payload'];
    if (!isRecord(payload)) {
      throw new GraphDefinitionError(`演化提案 payload 须为 dict，收到 ${typeName(payload)}`);
    }
    const rawEvidence = data['evidence'];
    if (rawEvidence !== undefined && rawEvidence !== null && !isRecord(rawEvidence)) {
      throw new GraphDefinitionError('演化提案 evidence 须为 dict');
    }
    const rawMeta = data['meta'];
    if (rawMeta !== undefined && rawMeta !== null && !isRecord(rawMeta)) {
      throw new GraphDefinitionError('演化提案 meta 须为 dict');
    }
    return new EvolutionProposal({
      kind: rawKind as EvolutionProposalKind,
      payload,
      provenance: rawProvenance as EvolutionProvenance,
      confidence: data['confidence'] as number | null | undefined,
      evidence: isRecord(rawEvidence) ? { ...rawEvidence } : undefined,
      rationale: (data['rationale'] as string | undefined) ?? '',
      meta: isRecord(rawMeta) ? { ...rawMeta } : undefined,
    });
  }
}
