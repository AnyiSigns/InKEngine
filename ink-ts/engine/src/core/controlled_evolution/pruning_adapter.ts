/**
 * Wave-2 择优建议 → 受控演化提案的衔接适配器。
 *
 * 组织档案择优（core/org_archive/pruning.ts）产出 advisory 建议（常胜短路 /
 * 高失败降权 / 低使用高失败下架 / 常胜保持），本模块把其中**可执行的资产
 * 变更**升格为受控演化提案（kind 词表见 evolution_proposal.ts），保持全部
 * 证据与置信度随行（审批卡/审计可追溯），供后续受控通道（隔离试跑闸 →
 * 审批 → 补丁链/Guard）消费：
 *
 * - shortcut 常胜短路 → apply_shortcut（短路沉淀为直达覆盖行）；
 * - downrank 高失败降权 → downrank（转场降权权重标记）；
 * - retire 低使用高失败下架 → retire_scope（作用域资产下架）；
 * - keep 常胜保持 → 仅报告（无资产变更，产出 keep 报告清单，不进提案）。
 *
 * 阈值规则已在 evaluate_org_archive 内生效（建议都是已过阈值线的），适配器
 * 不再重复过滤；零副作用纯函数。
 */

import type { OrgArchive } from '../org_archive/org_archive.js';
import type {
  DownrankProposal,
  KeepProposal,
  OrgEvaluateOptions,
  OrgProposal,
} from '../org_archive/pruning.js';
import { evaluate_org_archive } from '../org_archive/pruning.js';
import {
  PROVENANCE_ORG,
  EvolutionProposal,
  type EvolutionProposalKind,
} from './evolution_proposal.js';

/** 降权默认权重（适配缺省：降权 = 把该转场偏好压到一半；见 weight 覆盖语义）。 */
export const DOWNRANK_PRIOR_WEIGHT = 0.5;

/** 适配产出：可执行提案 + keep 报告清单（keep 无资产变更，仅报告）。 */
export interface PruningAdaptation {
  proposals: EvolutionProposal[];
  keeps: KeepProposal[];
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function build(
  kind: EvolutionProposalKind,
  payload: Record<string, unknown>,
  confidence: number,
  evidence: Record<string, unknown>,
  rationale: string,
): EvolutionProposal {
  return new EvolutionProposal({
    kind,
    payload,
    provenance: PROVENANCE_ORG,
    confidence,
    evidence,
    rationale,
  });
}

function adapt_shortcut(p: Extract<OrgProposal, { kind: 'shortcut' }>): EvolutionProposal {
  return build(
    'apply_shortcut',
    { from: p.from, to: p.to, skip_scope: p.skip_scope },
    p.confidence,
    { ...p.evidence },
    `择优短路化：常胜链 ${p.from}→${p.skip_scope}→${p.to} 沉淀直连`
      + `（观测 ${p.evidence.relay_observations}，成功率 ${percent(p.evidence.relay_success_rate)}）`,
  );
}

function adapt_downrank(p: DownrankProposal): EvolutionProposal {
  return build(
    'downrank',
    {
      mode: {
        from: p.mode.from,
        to: p.mode.to,
        shape: p.mode.shape,
        commit: p.mode.commit,
      },
      weight: DOWNRANK_PRIOR_WEIGHT,
    },
    p.confidence,
    { ...p.evidence },
    `择优降权：转场 ${p.mode.from}→${p.mode.to} 高失败`
      + `（${percent(p.evidence.failure_rate)}）→ 偏好降至 ${DOWNRANK_PRIOR_WEIGHT}`,
  );
}

function adapt_retire(p: Extract<OrgProposal, { kind: 'retire' }>): EvolutionProposal {
  return build(
    'retire_scope',
    { scope: p.scope },
    p.confidence,
    { ...p.evidence },
    `择优下架：目录作用域 ${p.scope} 低使用高失败`
      + `（使用 ${p.evidence.observations}，失败率 ${percent(p.evidence.failure_rate)}）`
      + '——防资产无限膨胀',
  );
}

/** 把择优建议清单适配为受控演化提案（keep 单独报告；零副作用）。 */
export function adapt_pruning_proposals(items: readonly OrgProposal[]): PruningAdaptation {
  const proposals: EvolutionProposal[] = [];
  const keeps: KeepProposal[] = [];
  for (const item of items) {
    if (item.kind === 'shortcut') proposals.push(adapt_shortcut(item));
    else if (item.kind === 'downrank') proposals.push(adapt_downrank(item));
    else if (item.kind === 'retire') proposals.push(adapt_retire(item));
    else keeps.push(item);
  }
  return { proposals, keeps };
}

/** 全链入口：组织档案 → evaluate → 适配（P5-δ 接 闸 → 审批 → 应用的起点）。 */
export function evaluate_and_adapt(
  archive: OrgArchive,
  opts?: OrgEvaluateOptions,
): PruningAdaptation {
  return adapt_pruning_proposals(evaluate_org_archive(archive, opts));
}
