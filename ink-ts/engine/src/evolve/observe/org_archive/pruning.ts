/**
 * 组织档案择优判定（advisory）：常胜短路 / 高失败降权 / 低使用高失败下架。
 *
 * 择优对象 = 组织决策（该不该委托/并行几路/派给哪些作用域/归并契约/通道
 * 条件），不是图拓扑（§六）。本模块在组织档案（OrgArchive）之上跑**启发式
 * 判定**，产出**建议动作**（typed proposals：模式 + 置信度 + 证据摘要），供
 * 后续受控通道（隔离试跑验证 → 审批 → 补丁链/Guard）消费——本模块**零副作用**：
 * 不写存储、不自动应用、不接触目录资产。
 *
 * 四条规则（阈值全部具名常量 + docstring 理由，确定性可测）：
 * - shortcut 常胜短路：链模式 A→R→C 常胜（高成功率）且 R 通常是纯过路
 *   （收尾占比低）→ 建议跳过 R 直连；
 * - downrank 高失败降权：转场模式高失败率（failure+degraded 同计）→ 建议降权；
 * - retire 下架：目录作用域**低使用 + 高失败**（防资产无限膨胀）→ 建议下架；
 * - keep 常胜保持：转场模式高使用 + 高成功 → 建议维持/加权（winner 调整）。
 *
 * 低使用**不单独**降权：新结晶/新孵化模式使用天然低，单凭低使用会误伤——
 * 仅在叠加高失败时进入下架路径。择优启发信号是近似的（成本均值为「含该模式
 * 的执行」平均成本），故一律带证据摘要交人工/审批复核。
 */

import { type ChannelCommit, type ChannelShape } from '../../../model/channels/channel_spec.js';
import { FACTORY_SCOPE_ROLES } from '../../../model/scopes/scope_spec.js';
import { OrgArchive } from './org_archive.js';
import { decode_chain_key, decode_transition_key } from './org_patterns.js';
import { failure_rate, success_rate } from './org_stats.js';

// ── 阈值常量（启发式；数值口径供人工与测试核对）──

/** 任何择优动作前的最小观测数（防止小样本噪声触发资产变更）。 */
export const ORG_MIN_EVIDENCE = 8;
/** 常胜短路前的中继链最小观测数。 */
export const ORG_SHORTCUT_MIN_EVIDENCE = 8;
/** 常胜判定线：中继链成功率 ≥ 0.9 才算常胜。 */
export const ORG_SHORTCUT_MIN_SUCCESS_RATE = 0.9;
/** 中继作用域收尾占比上限：R 大多不是终点（纯过路）才谈得上跳过。 */
export const ORG_SHORTCUT_MAX_TERMINAL_RATIO = 0.3;
/** 高失败降权前的最小观测数。 */
export const ORG_DOWNRANK_MIN_EVIDENCE = 8;
/** 降权触发线：failure+degraded 占比 ≥ 0.5。 */
export const ORG_DOWNRANK_FAILURE_RATE = 0.5;
/** 下架候选的最少样本（低于它失败样本不足，不能下架）。 */
export const ORG_RETIRE_MIN_EVIDENCE = 5;
/** 低使用上限：使用数不高于它才谈得上「低使用」。 */
export const ORG_RETIRE_MAX_USAGE = 10;
/** 低使用作用域的下架失败率触发线（failure+degraded 占比 ≥ 0.6）。 */
export const ORG_RETIRE_FAILURE_RATE = 0.6;
/** 常胜保持建议的最小观测数。 */
export const ORG_KEEP_MIN_EVIDENCE = 8;
/** 常胜保持建议的成功率线。 */
export const ORG_KEEP_MIN_SUCCESS_RATE = 0.9;

/** 阈值选项（全部可选覆写；缺省 = 上述常量）。 */
export interface PruningThresholds {
  minEvidence?: number;
  shortcutMinEvidence?: number;
  shortcutMinSuccessRate?: number;
  shortcutMaxTerminalRatio?: number;
  downrankMinEvidence?: number;
  downrankFailureRate?: number;
  retireMinEvidence?: number;
  retireMaxUsage?: number;
  retireFailureRate?: number;
  keepMinEvidence?: number;
  keepMinSuccessRate?: number;
}

/** 归一阈值（选项合并缺省常量）。 */
export function default_pruning_thresholds(): Required<PruningThresholds> {
  return {
    minEvidence: ORG_MIN_EVIDENCE,
    shortcutMinEvidence: ORG_SHORTCUT_MIN_EVIDENCE,
    shortcutMinSuccessRate: ORG_SHORTCUT_MIN_SUCCESS_RATE,
    shortcutMaxTerminalRatio: ORG_SHORTCUT_MAX_TERMINAL_RATIO,
    downrankMinEvidence: ORG_DOWNRANK_MIN_EVIDENCE,
    downrankFailureRate: ORG_DOWNRANK_FAILURE_RATE,
    retireMinEvidence: ORG_RETIRE_MIN_EVIDENCE,
    retireMaxUsage: ORG_RETIRE_MAX_USAGE,
    retireFailureRate: ORG_RETIRE_FAILURE_RATE,
    keepMinEvidence: ORG_KEEP_MIN_EVIDENCE,
    keepMinSuccessRate: ORG_KEEP_MIN_SUCCESS_RATE,
  };
}

/** 择优评估选项。 */
export interface OrgEvaluateOptions {
  thresholds?: Partial<PruningThresholds>;
  /** 下架候选只限目录已知作用域（缺省 = 出厂目录身份词汇；宿主可传实际目录）。 */
  directory_scopes?: readonly string[];
}

/** 组织模式引用（转场模式；证据/建议指向的最小单元）。 */
export interface OrgModeRef {
  from: string;
  to: string;
  shape: ChannelShape;
  commit: ChannelCommit;
}

/** 建议动作 kind（输出顺序：shortcut → downrank → retire → keep）。 */
export const ORG_PROPOSAL_KIND_ORDER = ['shortcut', 'downrank', 'retire', 'keep'] as const;
export type OrgProposalKind = (typeof ORG_PROPOSAL_KIND_ORDER)[number];

/** 常胜短路建议：跳过常胜中继 R，A 直达 C。 */
export interface ShortcutProposal {
  kind: 'shortcut';
  from: string;
  skip_scope: string;
  to: string;
  confidence: number;
  evidence: {
    relay_observations: number;
    relay_success_rate: number;
    mid_terminal_ratio: number;
    direct_seen: boolean;
    direct_observations: number;
  };
}

/** 高失败模式降权建议。 */
export interface DownrankProposal {
  kind: 'downrank';
  mode: OrgModeRef;
  confidence: number;
  evidence: {
    observations: number;
    failures: number;
    degraded: number;
    success_rate: number;
    failure_rate: number;
    last_seen_ms: number | null;
  };
}

/** 低使用高失败作用域资产下架建议（只对目录已知作用域；防资产无限膨胀）。 */
export interface RetireProposal {
  kind: 'retire';
  scope: string;
  confidence: number;
  evidence: {
    observations: number;
    failures: number;
    degraded: number;
    success_rate: number;
    failure_rate: number;
    last_seen_ms: number | null;
  };
}

/** 常胜保持（winner 维持/加权）建议。 */
export interface KeepProposal {
  kind: 'keep';
  mode: OrgModeRef;
  confidence: number;
  evidence: {
    observations: number;
    failures: number;
    degraded: number;
    success_rate: number;
    last_seen_ms: number | null;
  };
}

export type OrgProposal = ShortcutProposal | DownrankProposal | RetireProposal | KeepProposal;

/** 置信度：观测数相对所需证据下限的饱和曲线（obs=min → 0.5，渐近 1）。 */
export function proposal_confidence(observations: number, minEvidence: number): number {
  if (observations <= 0) return 0;
  return observations / (observations + minEvidence);
}

/** 归一评估选项（阈值 + 目录作用域候选集）。 */
function _effective(opts: OrgEvaluateOptions | undefined): {
  t: Required<PruningThresholds>;
  directory: readonly string[];
} {
  const t = { ...default_pruning_thresholds(), ...(opts?.thresholds ?? {}) };
  const given = opts?.directory_scopes;
  const directory = given === undefined ? FACTORY_SCOPE_ROLES : given;
  return { t, directory };
}

/** 直连存在性扫描：A→C 是否已有直连转场观察（跨形态/契约）。 */
function _direct_between(
  archive: OrgArchive,
  a: string,
  c: string,
): { seen: boolean; observations: number } {
  let seen = false;
  let observations = 0;
  for (const entry of archive.pattern_entries()) {
    const decoded = decode_transition_key(entry.key);
    if (decoded === null || decoded.from !== a || decoded.to !== c) continue;
    seen = true;
    observations += entry.stats.count;
  }
  return { seen, observations };
}

/** 常胜短路建议（链模式 A→R→C 常胜 + R 纯过路 → 建议直连跳 R）。 */
export function suggest_shortcuts(
  archive: OrgArchive,
  opts?: OrgEvaluateOptions,
): ShortcutProposal[] {
  const { t } = _effective(opts);
  const out: ShortcutProposal[] = [];
  for (const entry of archive.chain_entries()) {
    const chain = decode_chain_key(entry.key);
    if (chain === null) continue;
    const stats = entry.stats;
    if (stats.count < t.shortcutMinEvidence) continue;
    if (success_rate(stats) < t.shortcutMinSuccessRate) continue;
    // R 的「自身完成」次数低（相对该链过路次数）→ 常是纯过路才建议跳过
    const terminalCount = archive.scope_usage(chain.mid)?.count ?? 0;
    const midTerminalRatio =
      stats.count + terminalCount === 0
        ? 0
        : terminalCount / (stats.count + terminalCount);
    if (midTerminalRatio > t.shortcutMaxTerminalRatio) continue;
    const direct = _direct_between(archive, chain.a, chain.c);
    out.push({
      kind: 'shortcut',
      from: chain.a,
      skip_scope: chain.mid,
      to: chain.c,
      confidence: proposal_confidence(stats.count, t.shortcutMinEvidence),
      evidence: {
        relay_observations: stats.count,
        relay_success_rate: success_rate(stats),
        mid_terminal_ratio: midTerminalRatio,
        direct_seen: direct.seen,
        direct_observations: direct.observations,
      },
    });
  }
  out.sort((x, y) => y.confidence - x.confidence);
  return out;
}

/** 高失败模式降权建议（转场模式失败+降级占比超线）。 */
export function suggest_downranks(
  archive: OrgArchive,
  opts?: OrgEvaluateOptions,
): DownrankProposal[] {
  const { t } = _effective(opts);
  const out: DownrankProposal[] = [];
  for (const entry of archive.pattern_entries()) {
    const mode = decode_transition_key(entry.key);
    if (mode === null) continue;
    const stats = entry.stats;
    if (stats.count < t.downrankMinEvidence) continue;
    if (failure_rate(stats) < t.downrankFailureRate) continue;
    out.push({
      kind: 'downrank',
      mode: { from: mode.from, to: mode.to, shape: mode.shape, commit: mode.commit },
      confidence: proposal_confidence(stats.count, t.downrankMinEvidence),
      evidence: {
        observations: stats.count,
        failures: stats.failure,
        degraded: stats.degraded,
        success_rate: success_rate(stats),
        failure_rate: failure_rate(stats),
        last_seen_ms: stats.last_seen_ms,
      },
    });
  }
  out.sort((x, y) => y.confidence - x.confidence);
  return out;
}

/** 低使用高失败作用域资产下架建议（只对目录已知作用域；防资产无限膨胀）。 */
export function suggest_retires(
  archive: OrgArchive,
  opts?: OrgEvaluateOptions,
): RetireProposal[] {
  const { t, directory } = _effective(opts);
  const out: RetireProposal[] = [];
  for (const entry of archive.scope_entries()) {
    if (!(directory as readonly string[]).includes(entry.key)) continue;
    const stats = entry.stats;
    if (stats.count < t.retireMinEvidence) continue;
    if (stats.count > t.retireMaxUsage) continue;
    if (failure_rate(stats) < t.retireFailureRate) continue;
    out.push({
      kind: 'retire',
      scope: entry.key,
      confidence: proposal_confidence(stats.count, t.retireMinEvidence),
      evidence: {
        observations: stats.count,
        failures: stats.failure,
        degraded: stats.degraded,
        success_rate: success_rate(stats),
        failure_rate: failure_rate(stats),
        last_seen_ms: stats.last_seen_ms,
      },
    });
  }
  out.sort((x, y) => y.confidence - x.confidence);
  return out;
}

/** 常胜保持建议（高使用 + 高成功的转场模式：维持/加权，供先验调整参照）。 */
export function suggest_keeps(archive: OrgArchive, opts?: OrgEvaluateOptions): KeepProposal[] {
  const { t } = _effective(opts);
  const out: KeepProposal[] = [];
  for (const entry of archive.pattern_entries()) {
    const mode = decode_transition_key(entry.key);
    if (mode === null) continue;
    const stats = entry.stats;
    if (stats.count < t.keepMinEvidence) continue;
    if (success_rate(stats) < t.keepMinSuccessRate) continue;
    out.push({
      kind: 'keep',
      mode: { from: mode.from, to: mode.to, shape: mode.shape, commit: mode.commit },
      confidence: proposal_confidence(stats.count, t.keepMinEvidence),
      evidence: {
        observations: stats.count,
        failures: stats.failure,
        degraded: stats.degraded,
        success_rate: success_rate(stats),
        last_seen_ms: stats.last_seen_ms,
      },
    });
  }
  out.sort((x, y) => y.confidence - x.confidence);
  return out;
}

/** 全量择优判定（固定顺序输出；纯函数，不改动档案）。 */
export function evaluate_org_archive(
  archive: OrgArchive,
  opts?: OrgEvaluateOptions,
): OrgProposal[] {
  const shortcut: OrgProposal[] = suggest_shortcuts(archive, opts);
  const downrank: OrgProposal[] = suggest_downranks(archive, opts);
  const retire: OrgProposal[] = suggest_retires(archive, opts);
  const keep: OrgProposal[] = suggest_keeps(archive, opts);
  return [...shortcut, ...downrank, ...retire, ...keep];
}
