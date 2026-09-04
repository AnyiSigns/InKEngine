/**
 * 评审域的确定性基线参考实现（review.py 移植的核心文件）：
 * DeterministicReviewer / DeterministicRegenerator / DeterministicWebVerifier。
 *
 * 双轨收敛：产品 LLM 评审权威实现位于宿主层 review_pipeline（宿主注入
 * 模型链，评审失败 fail-open 中性分）；core 侧不承载 LLM 评审实现，只提供
 * 协议接口与**确定性基线参考实现**——纯启发式、无随机 / 无 LLM / 无 IO，
 * 同输入产出恒等，作为 LLM 评审的回归基线：评审行为漂移时基线给出稳定
 * 参照、同输入断言不漂移的锚定点。换评审策略 / 换验证后端不改本模块。
 *
 * TS 移植说明：
 * - 基线方法保持 async 形态与协议 seam（review_types.js）对齐——await 后
 *   返回恒等结果，无副作用，core 零 IO / 零随机约束天然满足；
 * - Python frozen dataclass 语义以 readonly + Object.freeze 表达；
 * - 数据面（常量/评审数据类/协议 seam）与收敛策略面（ConvergencePolicy /
 *   MaxRoundsConvergencePolicy / Convergence* 留痕数据类）分别定义于
 *   review_types.js 与 review_policies.js，本文件统一再导出——外部按单一
 *   模块名取用，镜像 Python 单模块 import 面。
 */

import {
  CandidateReview,
  DEFAULT_BEAM_WIDTH,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_PASS_THRESHOLD,
  NEUTRAL_SCORE,
  ParagraphScore,
} from './review_types.js';
import type { ReviewContext, Reviewer, Regenerator, WebVerifier } from './review_types.js';

/**
 * 确定性基线评审器（回归基线参考实现，非产品权威实现）。
 *
 * 与 Reviewer 协议对齐：按下标一一对应返回；评审不抛错——纯函数恒产出
 * 有效分。属性：pass_threshold = 判定通过的质量分阈值（与引擎默认同源
 * 0.75）；neutral = 中性分（保留协议语义；确定性评审永不失败，恒产出
 * 实分）。
 */
export class DeterministicReviewer implements Reviewer {
  readonly pass_threshold: number;
  readonly neutral: number;

  constructor(
    pass_threshold: number = DEFAULT_PASS_THRESHOLD,
    neutral: number = NEUTRAL_SCORE,
  ) {
    this.pass_threshold = pass_threshold;
    this.neutral = neutral;
    Object.freeze(this);
  }

  /** 对候选逐条评分：score >= pass_threshold 判 passed，feedback 携带理由。 */
  async review(
    candidates: readonly string[],
    _context?: ReviewContext,
  ): Promise<CandidateReview[]> {
    const results: CandidateReview[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const content = candidates[index] ?? '';
      const [score, reason] = this._score(content);
      results.push(
        new CandidateReview(
          index,
          score,
          score >= this.pass_threshold,
          reason,
        ),
      );
    }
    return results;
  }

  /**
   * 确定性质量分（纯函数）：长度分 60% + 段落结构分 40%，锚定 [0,1]。
   * 长度分 = min(len/500, 1)；结构分 = min(换行数/4, 1)。
   *
   * 分数四舍五入到 4 位小数：加权和的真实分母为 2500，缩放 10000 后恰为
   * 整数（12·len_capped + 1000·nl_capped）/10000——结果落在 4 位小数的
   * 网格上，用整数闭式取值而非浮点累加后取整，规避边界漂移；与 Python
   * round(0.6·长度分 + 0.4·结构分, 4) 的网格值一致（该加权和同样精确落在
   * 网格点，无半分位歧义）。同输入恒等，作为回归基线的断言锚点。
   */
  private _score(text: string): readonly [number, string] {
    const length_score = Math.min(text.length / 500.0, 1.0);
    const structure_score = Math.min((text.split('\n').length - 1) / 4.0, 1.0);
    const length_capped = Math.min(text.length, 500);
    const structure_capped = Math.min(text.split('\n').length - 1, 4);
    const score = (12 * length_capped + 1000 * structure_capped) / 10000;
    const reason = `确定性基线：长度分 ${length_score.toFixed(2)}，结构分 ${structure_score.toFixed(2)}`;
    return [score, reason];
  }
}

/**
 * 确定性基线再生成器（回归基线参考实现，非产品权威实现）。
 *
 * 按评审反馈**追加修订段**（无随机 / 无 LLM / 无 IO），同输入产出恒等，
 * 作为再生成路径的回归基线。空反馈（含纯空白）不改动候选，原样返回。
 */
export class DeterministicRegenerator implements Regenerator {
  async regenerate(
    candidate: string,
    feedback: string,
    _context?: ReviewContext,
  ): Promise<string> {
    const trimmed = feedback.trim();
    if (trimmed === '') return candidate;
    return `${candidate}\n\n【确定性基线修订】${trimmed}`;
  }
}

/**
 * 确定性基线 web 验证器（回归基线参考实现）。
 *
 * 返回占位结论（不触发真实联网验证），同输入产出恒等——验证路径的回归
 * 基线；真实验证后端由宿主注册（WebVerifier seam）。
 */
export class DeterministicWebVerifier implements WebVerifier {
  async verify(
    claim: string,
    _context?: ReviewContext,
  ): Promise<string> {
    return `【确定性基线验证】${claim}（未触发真实联网验证，占位结论）`;
  }
}

export {
  CandidateReview,
  DEFAULT_BEAM_WIDTH,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_PASS_THRESHOLD,
  NEUTRAL_SCORE,
  ParagraphScore,
};
export type { Regenerator, ReviewContext, Reviewer, WebVerifier } from './review_types.js';
export {
  ConvergenceDecision,
  ConvergenceResult,
  ConvergenceRound,
  MaxRoundsConvergencePolicy,
} from './review_policies.js';
export type { ConvergencePolicy } from './review_policies.js';
