/**
 * 受控演化应用计划（纯函数：提案 → 目录感知校验 → 可执行步骤清单）。
 *
 * 计划层是受控通道的「预案」：对照当前实体目录/通道目录/先验覆盖语义，把
 * 一条受控演化提案解析成可执行步骤（register/replace/retire/封/upsert），
 * 或返回可读违规清单（fail-closed，不产生任何副作用）。最终写盘步骤全部
 * 落在步骤清单里由应用管线执行（受控演化应用层），本模块零 IO、零状态。
 *
 * 作用域资产 = 实体目录的带 scope 实体（新增/更新/下架走 EntityRegistry
 * 语义 + EvolutionWriter）；通道资产 = 通道目录（新增/更新/封走 ChannelSpec
 * 语义）；先验覆盖（route/shortcut/weight）在组织先验覆盖行上 upsert
 * （见 core/scopes/prior_overlay.ts）。词汇全部复用 Wave-1/2 数据面。
 */

import { ChannelSpec, channel_with_disabled } from '../channels/channel_spec.js';
import {
  EntitySpec,
  retire_entity_record,
} from '../entities/entities.js';
import { transition_key_of } from '../org_archive/org_patterns.js';
import { isRecord } from '../json.js';
import {
  route_overlay,
  shortcut_overlay,
  weight_overlay,
  type OrgPriorOverlay,
} from '../scopes/prior_overlay.js';
import { scope_prior_from_dict } from '../scopes/scope_priors.js';
import type { EvolutionProposal } from './evolution_proposal.js';
import { is_channel_kind } from './evolution_proposal.js';

// ── 目录读取契约（窄结构：计划只读不写，任一派生目录满足即可测）──

/** 作用域实体目录读取面（EntityRegistry 满足；按 id 返回或 null）。 */
export interface PlanEntityDirectory {
  get(entity_id: string): EntitySpec | null;
}

/** 通道目录读取面（ChannelDirectory 满足）。 */
export interface PlanChannelDirectory {
  get(channel_id: string): ChannelSpec | null;
}

/** 应用计划上下文（目录读取面；可为空 = 校验只按载荷与词表）。 */
export interface ApplyPlanContext {
  entities?: PlanEntityDirectory | null;
  channels?: PlanChannelDirectory | null;
}

/** 可执行步骤（受控演化应用管线消费：先 writer 落盘，后内存目录换入）。 */
export type EvolutionPlanStep =
  | { op: 'register_scope'; spec: EntitySpec }
  | { op: 'replace_scope'; spec: EntitySpec }
  | { op: 'retire_scope'; spec: EntitySpec; record: Record<string, unknown> }
  | { op: 'register_channel'; spec: ChannelSpec }
  | { op: 'replace_channel'; spec: ChannelSpec }
  | { op: 'seal_channel'; spec: ChannelSpec }
  | { op: 'upsert_prior'; overlay: OrgPriorOverlay };

/** 应用计划结果：ok=false 携带违规清单（fail-closed，不产生步骤）。 */
export interface ApplyPlanResult {
  ok: boolean;
  violations: string[];
  steps: EvolutionPlanStep[];
}

const NO_ENTITIES = '实体目录不可用（校验需目录状态）';

function entity_scope_plan(
  kind: 'add_scope' | 'update_scope',
  proposal: EvolutionProposal,
  entities: PlanEntityDirectory | null,
  out: ApplyPlanResult,
): void {
  const asset = proposal.asset_record();
  if (asset === null) {
    out.violations.push('scope 提案缺 asset（dict）');
    return;
  }
  let spec: EntitySpec;
  try {
    spec = EntitySpec.from_dict(asset);
  } catch (error) {
    out.violations.push(`scope 资产声明非法: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (entities === null) {
    out.violations.push(NO_ENTITIES);
    return;
  }
  const existing = entities.get(spec.id);
  if (kind === 'add_scope') {
    if (existing !== null) {
      out.violations.push(`作用域资产已存在（${spec.id}）——新增须目标不存在，更新请走 update_scope`);
      return;
    }
    out.steps.push({ op: 'register_scope', spec });
    return;
  }
  if (existing === null) {
    out.violations.push(`作用域资产不存在（${spec.id}）——更新须目标存在`);
    return;
  }
  if (existing.scope === null) {
    out.violations.push(`实体 ${spec.id} 非作用域资产（缺 scope 声明块）`);
    return;
  }
  out.steps.push({ op: 'replace_scope', spec });
}

function channel_plan(
  kind: 'add_channel' | 'update_channel' | 'seal_channel',
  proposal: EvolutionProposal,
  channels: PlanChannelDirectory | null,
  out: ApplyPlanResult,
): void {
  if (channels === null) {
    out.violations.push('通道目录不可用（校验需目录状态）');
    return;
  }
  if (kind === 'seal_channel') {
    const channelId = proposal.payload['channel'] as string;
    const existing = channels.get(channelId);
    if (existing === null) {
      out.violations.push(`通道不存在（${channelId}）——封禁须目标存在`);
      return;
    }
    if (existing.disabled) {
      out.violations.push(`通道已封禁（${channelId}），重复封禁无意义`);
      return;
    }
    out.steps.push({ op: 'seal_channel', spec: channel_with_disabled(existing, true) });
    return;
  }
  const asset = proposal.asset_record();
  if (asset === null) {
    out.violations.push('channel 提案缺 asset（dict）');
    return;
  }
  let spec: ChannelSpec;
  try {
    spec = ChannelSpec.from_dict(asset);
  } catch (error) {
    out.violations.push(`channel 声明非法: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const existing = channels.get(spec.id);
  if (kind === 'add_channel') {
    if (existing !== null) {
      out.violations.push(`通道已存在（${spec.id}）——新增须目标不存在，更新请走 update_channel`);
      return;
    }
    out.steps.push({ op: 'register_channel', spec });
    return;
  }
  if (existing === null) {
    out.violations.push(`通道不存在（${spec.id}）——更新须目标存在`);
    return;
  }
  if (!existing.disabled && spec.disabled) {
    out.violations.push(`通道 ${spec.id} 启用中——封禁请走 seal_channel（变更条件用 update 不带 disabled）`);
    return;
  }
  out.steps.push({ op: 'replace_channel', spec });
}

function prior_plan(
  kind: 'update_prior' | 'apply_shortcut' | 'downrank',
  proposal: EvolutionProposal,
  out: ApplyPlanResult,
): void {
  if (kind === 'update_prior') {
    const rawPattern = proposal.payload['pattern'];
    if (!isRecord(rawPattern)) {
      out.violations.push('update_prior 载荷缺 pattern（dict）');
      return;
    }
    try {
      out.steps.push({ op: 'upsert_prior', overlay: route_overlay(scope_prior_from_dict(rawPattern)) });
    } catch (error) {
      out.violations.push(`先验模式非法: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (kind === 'apply_shortcut') {
    const from = proposal.payload['from'] as string;
    const to = proposal.payload['to'] as string;
    const skip = proposal.payload['skip_scope'] as string;
    if (skip === from || skip === to) {
      out.violations.push('apply_shortcut 的中继 skip_scope 须与 from/to 不同（跳过的是中继作用域）');
      return;
    }
    const rawWeight = proposal.payload['weight'];
    const weight = typeof rawWeight === 'number' ? rawWeight : undefined;
    try {
      out.steps.push({
        op: 'upsert_prior',
        overlay: shortcut_overlay(from, to, skip, weight),
      });
    } catch (error) {
      out.violations.push(`shortcut 直连非法: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  // downrank
  const mode = isRecord(proposal.payload['mode']) ? proposal.payload['mode'] : null;
  const weight = proposal.payload['weight'];
  if (mode === null || typeof weight !== 'number') {
    out.violations.push('downrank 载荷缺 mode（dict）或 weight（数值）');
    return;
  }
  const ref = transition_key_of({
    from: mode['from'] as string,
    to: mode['to'] as string,
    shape: mode['shape'] as never,
    commit: mode['commit'] as never,
  });
  try {
    out.steps.push({ op: 'upsert_prior', overlay: weight_overlay(ref, weight) });
  } catch (error) {
    out.violations.push(`降权权重非法: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 把提案解析成应用计划（纯函数；不改动任何目录）。 */
export function plan_evolution(
  proposal: EvolutionProposal,
  ctx: ApplyPlanContext = {},
): ApplyPlanResult {
  const out: ApplyPlanResult = { ok: false, violations: [], steps: [] };
  if (proposal.kind === 'add_scope' || proposal.kind === 'update_scope') {
    entity_scope_plan(proposal.kind, proposal, ctx.entities ?? null, out);
  } else if (proposal.kind === 'retire_scope') {
    const scopeId = proposal.payload['scope'] as string;
    const entities = ctx.entities ?? null;
    if (entities === null) {
      out.violations.push(NO_ENTITIES);
    } else {
      const existing = entities.get(scopeId);
      if (existing === null) {
        out.violations.push(`作用域资产不存在（${scopeId}）——下架须目标存在`);
      } else if (existing.scope === null) {
        out.violations.push(`实体 ${scopeId} 非作用域资产（缺 scope 声明块）`);
      } else {
        const reason =
          typeof proposal.payload['reason'] === 'string'
            ? (proposal.payload['reason'] as string)
            : proposal.rationale;
        out.steps.push({
          op: 'retire_scope',
          spec: existing,
          record: retire_entity_record(existing, { reason, domain: 'controlled_evolution' }),
        });
      }
    }
  } else if (is_channel_kind(proposal.kind)) {
    channel_plan(proposal.kind, proposal, ctx.channels ?? null, out);
  } else {
    prior_plan(proposal.kind, proposal, out);
  }
  out.ok = out.violations.length === 0 && out.steps.length > 0;
  return out;
}
