/**
 * 评审-收敛的默认策略与收敛循环留痕（review.py 移植）。
 *
 * 双轨收敛的循环机制语义拆分：
 * - 何时收敛 / 再生成几个候选 = 收敛策略决策（业务可替换，见
 *   ConvergencePolicy seam 与 MaxRoundsConvergencePolicy 默认实现）；
 * - 再生成 → 评审 → 再决策的循环推进 = 引擎统一实现的机制，其每轮与最终
 *   留痕由 ConvergenceRound / ConvergenceResult 承载（可审计可落 JSON）。
 *
 * TS 移植说明：
 * - ConvergenceDecision / ConvergenceRound / ConvergenceResult 为只读/可变
 *   数据形态，值域 JSON 兼容；ConvergenceDecision 构造即冻结（Python frozen
 *   dataclass），字段赋值在 ES 严格模式抛 TypeError；
 * - 收敛判定只认策略 threshold 单一门槛（评审器 passed 仅留痕展示）；
 * - Python tuple 以 readonly 数组表达。
 */

import {
  DEFAULT_BEAM_WIDTH,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_PASS_THRESHOLD,
} from './review_types.js';
import type { CandidateReview } from './review_types.js';

/**
 * 收敛策略的一轮决策结果。
 * converged：是否收敛（满足通过条件，停止迭代）；accepted_indices：收敛时
 * 被接受的候选下标（按分降序，取最高分）；regenerate_indices：未收敛时下一
 * 轮继续再生成的候选下标（Beam 宽度）；notes：决策留痕（可读说明）。
 */
export class ConvergenceDecision {
  readonly converged: boolean;
  readonly accepted_indices: readonly number[];
  readonly regenerate_indices: readonly number[];
  readonly notes: readonly string[];

  constructor(
    converged: boolean,
    accepted_indices: readonly number[] = [],
    regenerate_indices: readonly number[] = [],
    notes: readonly string[] = [],
  ) {
    this.converged = converged;
    this.accepted_indices = accepted_indices;
    this.regenerate_indices = regenerate_indices;
    this.notes = notes;
    Object.freeze(this);
  }
}

/**
 * 收敛策略 seam：由评审结果决定「收敛 or 再生成哪个候选」。
 * 语义拆分：何时收敛 / 再生成几个 = 策略决策（业务可替换）；再生成 → 评审
 * → 再决策 = 循环机制（引擎统一实现）。
 */
export interface ConvergencePolicy {
  decide(reviews: readonly CandidateReview[], round_no: number): ConvergenceDecision;
}

/**
 * 默认收敛策略：达阈值即收敛，否则 Beam 再生成，直到轮次上限。
 *
 * 规则：
 * 1. 存在分数 ≥ 策略 threshold 的候选 → 收敛，接受其中分数最高者（同分取
 *    靠前者）——threshold 是唯一收敛门槛（评审器 passed 不参与判定）；
 * 2. 未收敛但已到轮次上限 → 停止（converged=False，呈交现状 + 评审意见）；
 * 3. 否则取分数前 K（Beam 宽度）个候选继续再生成。
 *
 * 空评审集 = 无候选可判定，收敛失败——绝不把空集当「已收敛」（调用方按
 * converged 取候选会拿到空集崩溃）。
 *
 * 轮次上限硬护栏：策略内部自增轮次计数，decide 按 max(round_no, 已用轮次)
 * 判定上限——循环驱动层误传常量（如恒 0）时仍有绝对硬上限兜底，不会无限
 * 再生成。
 */
export class MaxRoundsConvergencePolicy implements ConvergencePolicy {
  readonly threshold: number;
  readonly beam: number;
  readonly max_rounds: number;
  private rounds_used = 0;

  constructor(
    threshold: number = DEFAULT_PASS_THRESHOLD,
    beam: number = DEFAULT_BEAM_WIDTH,
    max_rounds: number = DEFAULT_MAX_ROUNDS,
  ) {
    if (threshold < 0 || threshold > 1) {
      throw new RangeError(`评审阈值必须在 [0, 1] 内: ${threshold}`);
    }
    if (beam < 1) {
      throw new RangeError(`Beam 宽度必须为正: ${beam}`);
    }
    if (max_rounds < 0) {
      throw new RangeError(`轮次上限不能为负: ${max_rounds}`);
    }
    this.threshold = threshold;
    this.beam = beam;
    this.max_rounds = max_rounds;
  }

  /** 有效轮次 = 调用方轮次与内部计数的较大者（内部计数单调自增）。
   * 调用方按轮递增时二者一致；调用方误传常量/回退轮次时内部计数保证硬
   * 上限语义（已用轮次不受调用方回拨影响）。 */
  private effective_round(round_no: number): number {
    this.rounds_used = Math.max(this.rounds_used, round_no);
    return this.rounds_used;
  }

  /** 一轮决策：收敛 / 到上限停止 / Beam 再生成（按有效轮次判定）。 */
  decide(reviews: readonly CandidateReview[], round_no: number): ConvergenceDecision {
    round_no = this.effective_round(round_no);
    if (reviews.length === 0) {
      return new ConvergenceDecision(false, [], [], ['无候选可评审']);
    }
    // 单一阈值源：收敛判定只认策略 threshold——评审器的 passed 标志（自身
    // 阈值预计算）不再作为第二道门槛。双重门槛会让「达标但低于策略门槛」
    // 的候选被反复再生成直至轮次上限，可能永不收敛。
    let bestPassed: CandidateReview | null = null;
    for (const r of reviews) {
      if (r.score >= this.threshold) {
        if (bestPassed === null || r.score > bestPassed.score) bestPassed = r;
      }
    }
    if (bestPassed !== null) {
      return new ConvergenceDecision(
        true,
        [bestPassed.candidate_index],
        [],
        [`候选[${bestPassed.candidate_index}] 达标（${bestPassed.score.toFixed(2)}），收敛`],
      );
    }
    let best: CandidateReview = reviews[0]!;
    for (const r of reviews) {
      if (r.score > best.score) best = r;
    }
    if (round_no >= this.max_rounds) {
      return new ConvergenceDecision(
        false,
        [],
        [],
        [
          `达轮次上限（${round_no}/${this.max_rounds}），呈交现状，` +
            `最优候选[${best.candidate_index}] 得分 ${best.score.toFixed(2)}`,
        ],
      );
    }
    const ranked = [...reviews].sort((a, b) => b.score - a.score);
    const picks = ranked.slice(0, this.beam).map((r) => r.candidate_index);
    return new ConvergenceDecision(
      false,
      [],
      picks,
      [`第 ${round_no + 1} 轮未达标，再生成候选 [${picks.join(', ')}]`],
    );
  }
}

/** 一轮评审-再生成的完整留痕（循环历史可审计）。 */
export class ConvergenceRound {
  round_no: number;
  reviews: CandidateReview[];
  decision: ConvergenceDecision;
  regenerated: readonly string[];

  constructor(
    round_no: number,
    reviews: CandidateReview[],
    decision: ConvergenceDecision,
    regenerated: readonly string[] = [],
  ) {
    this.round_no = round_no;
    this.reviews = reviews;
    this.decision = decision;
    this.regenerated = regenerated;
  }
}

/**
 * 评审-收敛循环的最终结果。
 * candidates：收敛候选（converged=True 时为接受的候选）或最终候选集（超限
 * 时呈交现状，含评审意见供人类裁决）；reviews：最后一轮评审结果；
 * converged：是否自动收敛（否则已超限，交卡回路人类裁决）；rounds：实际
 * 执行的再生成轮数；notes：全程留痕（失败回退 / 轮次记录等）；history：
 * 每轮评审-再生成明细。
 */
export class ConvergenceResult {
  candidates: string[];
  reviews: CandidateReview[];
  converged: boolean;
  rounds: number;
  notes: string[];
  history: ConvergenceRound[];

  constructor(
    candidates: string[],
    reviews: CandidateReview[],
    converged: boolean,
    rounds: number,
    notes: string[] = [],
    history: ConvergenceRound[] = [],
  ) {
    this.candidates = candidates;
    this.reviews = reviews;
    this.converged = converged;
    this.rounds = rounds;
    this.notes = notes;
    this.history = history;
  }

  /**
   * 当前候选集中得分最高者的列表位置（candidates 下标）。
   * 按评审器协议（reviews 与 candidates 按下标一一对应）取 reviews 中最高
   * 分者的**序列位置**作为 candidates 下标——不直接信任评审器的
   * candidate_index 字段（该下标来自评审轮内枚举，候选被过滤/跨轮重组后
   * 直接引用会取错候选）；候选集被过滤后位置越界 = 回落 0（收敛接受的候选
   * 落在首位，与收敛决策语义一致）。
   */
  get best_index(): number {
    if (this.reviews.length === 0) return 0;
    let best_pos = 0;
    for (let i = 1; i < this.reviews.length; i += 1) {
      const current = this.reviews[i]!;
      const best = this.reviews[best_pos]!;
      if (current.score > best.score) best_pos = i;
    }
    if (best_pos < this.candidates.length) return best_pos;
    return 0;
  }
}
