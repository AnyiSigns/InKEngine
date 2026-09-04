/**
 * 评审-收敛原语的数据面（review.py 移植）：
 * - 默认常量：再生成轮次上限 / 通过阈值 / Beam 宽度 / 中性分；
 * - 评审数据类：ParagraphScore（段落评分）、CandidateReview（单候选评审）；
 * - 协议 seam：Reviewer（评审）/ Regenerator（再生成）/ WebVerifier（web
 *   验证）——实现由宿主注入（产品权威实现走宿主模型链，评审失败 fail-open
 *   中性分，不阻断主流程）。
 *
 * 收敛策略与确定性基线分别见 review_policies.js / review.js。
 *
 * TS 移植说明：
 * - Python frozen dataclass 的「字段只读 + 赋值即抛错」以 readonly 字段 +
 *   Object.freeze 实例表达（ES 严格模式下赋值抛 TypeError）；
 * - Python tuple 以 readonly 数组表达（JSON 兼容，同输入产出恒等不受影响）；
 * - 上下文 seam 取值 JSON 兼容（Record<string, unknown> | null）。
 */

/** 自动再生成轮次上限（2-3 轮；超限呈交现状 + 评审意见，卡回路人类裁决兜底）。 */
export const DEFAULT_MAX_ROUNDS = 2;

/** 评审通过阈值（0-1 质量分；评审器自身也用它判定 passed）。 */
export const DEFAULT_PASS_THRESHOLD = 0.75;

/** 未收敛时继续再生成的候选数（Beam 宽度：取前 K 个最优候选迭代）。 */
export const DEFAULT_BEAM_WIDTH = 1;

/** 评审未产出结论时的中性分（fail-open：保守不通过，交卡回路人类裁决）。 */
export const NEUTRAL_SCORE = 0.5;

/** 评审/再生成/验证调用携带的可选业务上下文（宿主透传，本域不解释取值）。 */
export type ReviewContext = Record<string, unknown> | null;

/**
 * 单个段落的质量评分（段落级混合的输入，混合逐段位取最高分）。
 * candidate_index：所属候选下标；paragraph_index：段内段落序号（0 起，
 * 与 split_paragraphs 对齐）；score：归一化质量分（0-1）；reason：评分
 * 理由（可读留痕）。
 */
export class ParagraphScore {
  readonly candidate_index: number;
  readonly paragraph_index: number;
  readonly score: number;
  readonly reason: string;

  constructor(
    candidate_index: number,
    paragraph_index: number,
    score: number,
    reason = '',
  ) {
    this.candidate_index = candidate_index;
    this.paragraph_index = paragraph_index;
    this.score = score;
    this.reason = reason;
    Object.freeze(this);
  }
}

/**
 * 单个候选的一次评审结果。
 * candidate_index：候选下标；score：候选整体质量分（0-1，通常为段落分
 * 均值）；passed：是否达到评审器自身阈值（预计算，仅供留痕/展示）；
 * feedback：改进意见（再生成指导）；paragraphs：段落级评分（混合用，
 * 评审器未产出时为空）；uncertain_claims：评审发现的存疑事实声明（触发
 * web 验证）。
 *
 * passed 语义：评审器按自身阈值（pass_threshold）预计算的达标标志，仅供
 * 留痕/展示——收敛判定以策略 threshold 为唯一门槛，不把两者叠加成双重
 * 门槛（见 review_policies.js）。
 */
export class CandidateReview {
  readonly candidate_index: number;
  readonly score: number;
  readonly passed: boolean;
  readonly feedback: string;
  readonly paragraphs: readonly ParagraphScore[];
  readonly uncertain_claims: readonly string[];

  constructor(
    candidate_index: number,
    score: number,
    passed: boolean,
    feedback = '',
    paragraphs: readonly ParagraphScore[] = [],
    uncertain_claims: readonly string[] = [],
  ) {
    this.candidate_index = candidate_index;
    this.score = score;
    this.passed = passed;
    this.feedback = feedback;
    this.paragraphs = paragraphs;
    this.uncertain_claims = uncertain_claims;
    Object.freeze(this);
  }
}

/**
 * 评审器 seam：对候选输出进行质量评审。
 * 返回与 candidates 一一对应的评审结果（按下标对齐）；评审失败不得抛错
 * ——应返回中性分（passed=False）或由循环层兜底，评审是 best-effort
 * 增强，不得阻断主流程。
 */
export interface Reviewer {
  review(candidates: readonly string[], context?: ReviewContext): Promise<CandidateReview[]>;
}

/** 再生成器 seam：按评审反馈改进单个候选（不达标自动再生成，不弹卡）。 */
export interface Regenerator {
  regenerate(candidate: string, feedback: string, context?: ReviewContext): Promise<string>;
}

/**
 * web 验证钩子 seam：评审存疑时验证事实（宿主注册博查等实现）。
 * 对单个存疑声明返回验证结果文本；返回 null 表示无需/无法验证。
 */
export interface WebVerifier {
  verify(claim: string, context?: ReviewContext): Promise<string | null>;
}
