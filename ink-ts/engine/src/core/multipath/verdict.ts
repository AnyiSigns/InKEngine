/**
 * 汇流裁决核心（multipath.py junction_verdict 段移植，1:1）。
 *
 * 同构择优链：质量闸门过者胜（无闸门或全部未过 → 降级比信任档 → 比成本
 * → 序号，确定性序）；异构：合成源产出（无源 → 降级信任档）。无论胜负：
 * 胜者边成功 +1，败者/失败支流只记入边失败（归因规则在 updates.ts）。
 * 裁决理由入审计留痕（junction 审计事件类型由事件注册表登记）。
 *
 * JunctionSynthProvider = 异构输出合成源协议（使用方注入：模板/模型调用
 * 方式归使用方；返回 null = 本次放弃合成，调用方降级信任档裁决）。
 */

import type { QualityGate } from '../contracts/contracts.js';
import {
  MODE_NONE,
  MODE_QUALITY_GATE,
  MODE_SYNTHETIC,
  MODE_TIER,
  tier_rank,
} from './constants.js';
import {
  JunctionBranch,
  JunctionSynthContext,
  JunctionVerdict,
} from './junction_types.js';

/** 判定结果可等待检测（镜像 Python inspect.isawaitable）。 */
function isThenable(value: unknown): value is Promise<boolean> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** 集合相等（同构判定：各支收尾字段集一致）。 */
function sameFieldSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((name) => setB.has(name));
}

/** 同构判定：各支收尾结点产出字段集一致（不一致 = 异构）。 */
export function branches_are_homogeneous(
  branches: readonly JunctionBranch[],
): boolean {
  if (branches.length === 0) return true;
  const first = branches[0]!.terminal_fields;
  return branches.every((b) => sameFieldSet(b.terminal_fields, first));
}

/** 信任档降序 → 成本升序 → 序号升序（确定性裁决序）。 */
export function _tier_cost_order(
  branches: readonly JunctionBranch[],
): readonly JunctionBranch[] {
  return [...branches].sort((a, b) => {
    const rankDiff = tier_rank(b.tier) - tier_rank(a.tier);
    if (rankDiff !== 0) return rankDiff;
    if (a.mean_cost !== b.mean_cost) return a.mean_cost - b.mean_cost;
    return a.index - b.index;
  });
}

/** 异构输出合成源（使用方注入；返回 None = 本次放弃合成）。 */
export interface JunctionSynthProvider {
  synthesize(context: JunctionSynthContext): Promise<Record<string, unknown> | null>;
}

/** 胜者收口：产物 = 胜者整体提交（来源留痕）。 */
export function _winner_verdict(
  winner: JunctionBranch,
  branches: readonly JunctionBranch[],
  opts: {
    mode: string;
    reasons: readonly string[];
    homogeneous: boolean;
  },
): JunctionVerdict {
  return new JunctionVerdict({
    mode: opts.mode,
    homogeneous: opts.homogeneous,
    winner: winner.index,
    selection: { ...winner.overlay },
    reasons: [...opts.reasons],
    losers: branches.filter((b) => b.index !== winner.index).map((b) => b.index),
    provenance: [
      { branch_index: winner.index, note: `整体提交（${opts.mode}）` },
    ],
  });
}

/**
 * 汇流裁决核心：同构纯算法择优 / 异构合成；理由入审计留痕。
 *
 * 模式集中确定（ENG2-17）：优先档位单一决策点——同构 → 质量闸门优先；
 * 异构 → 合成源优先；两者不可用/未过/失败统一降级信任档。各分支只做
 * 「通过即返回」/「失败追加降级理由」，不再分散赋 mode。
 */
export async function junction_verdict(
  branches: readonly JunctionBranch[],
  opts: {
    domain: string;
    goal?: readonly string[];
    quality_gate?: QualityGate | null;
    synth_provider?: JunctionSynthProvider | null;
    now?: number | null;
  },
): Promise<JunctionVerdict> {
  const domain = opts.domain;
  const goal = opts.goal ?? [];
  const quality_gate = opts.quality_gate ?? null;
  const synth_provider = opts.synth_provider ?? null;

  async function gate_passed(branch: JunctionBranch): Promise<boolean> {
    if (quality_gate === null) return false;
    try {
      const raw = quality_gate.judge(domain, branch.overlay);
      const verdict = isThenable(raw) ? await raw : raw;
      return Boolean(verdict);
    } catch {
      return false;
    }
  }

  if (branches.length === 0) {
    return new JunctionVerdict({
      mode: MODE_NONE,
      homogeneous: true,
      winner: null,
      selection: {},
      reasons: ['无可裁决支流（候选集为空）'],
    });
  }
  const homogeneous = branches_are_homogeneous(branches);
  const reasons: string[] = [];
  if (homogeneous && quality_gate !== null) {
    const passed: JunctionBranch[] = [];
    for (const b of branches) {
      if (await gate_passed(b)) passed.push(b);
    }
    if (passed.length > 0) {
      const ordered = _tier_cost_order(passed);
      const winner = ordered[0]!;
      reasons.push(
        `质量闸门过者胜（${passed.length}/${branches.length} 过关）` +
          (passed.length > 1
            ? `；同过者比信任档（${winner.tier}）再比成本` +
              `（${winner.mean_cost.toFixed(2)}）`
            : ''),
      );
      return _winner_verdict(winner, branches, {
        mode: MODE_QUALITY_GATE,
        reasons,
        homogeneous,
      });
    }
    reasons.push('质量闸门全部未过，降级信任档裁决');
  } else if (!homogeneous && synth_provider !== null) {
    let selection: Record<string, unknown> | null = null;
    try {
      const context = new JunctionSynthContext({
        domain,
        goal: [...goal],
        branches: [...branches],
        notes: ['异构输出：各支产物字段不一致'],
      });
      selection = await synth_provider.synthesize(context);
    } catch {
      selection = null;
    }
    if (selection !== null) {
      return new JunctionVerdict({
        mode: MODE_SYNTHETIC,
        homogeneous: false,
        winner: null,
        selection: { ...selection },
        reasons: ['异构输出经合成源合成（支流产物字段不一致）'],
        losers: branches.map((b) => b.index),
      });
    }
    reasons.push('异构合成无产出/失败，降级信任档裁决');
  } else if (!homogeneous) {
    reasons.push('异构输出且未注入合成源，降级信任档裁决');
  }
  const ordered = _tier_cost_order(branches);
  const winner = ordered[0]!;
  if (ordered.filter((b) => b.tier === winner.tier).length > 1) {
    reasons.push(
      `同信任档（${winner.tier}）比成本（胜 ${winner.mean_cost.toFixed(2)}）`,
    );
  }
  reasons.push(`信任档裁决胜出：${winner.index}（档位 ${winner.tier}）`);
  return _winner_verdict(winner, branches, {
    mode: MODE_TIER,
    reasons,
    homogeneous,
  });
}
