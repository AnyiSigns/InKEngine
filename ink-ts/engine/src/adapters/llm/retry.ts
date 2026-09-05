/**
 * 瞬时故障重试策略（RetryPolicy，Python core/llm/fallback.py 1:1 最小移植）。
 *
 * 重试唯一权威 = 链层 RetryPolicy：适配器默认单次尝试，仅当独立直用
 * （构造参数显式注入策略）时开启指数退避重试——杜绝「适配器 × 链」双层
 * 叠加（3×3=9 请求）。链/挡位层（ModelChain）随 fallback.py 迁移落
 * core/llm/fallback.ts；本文件先承载适配器可注入的策略形态，fallback
 * 落地后统一从 core 侧引用。
 */

/** 退避睡眠注入面（毫秒）：缺省真实计时，测试注入录制/假时钟零等待。 */
export type BackoffSleeper = (ms: number) => Promise<void>;

const _default_sleeper: BackoffSleeper = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** 重试策略（attempts = 总尝试次数，含首次；单一源，openai_compat /
 *  openai_responses / anthropic 适配器共用同一形态）。 */
export class RetryPolicy {
  readonly attempts: number;
  readonly base_delay: number;
  readonly max_delay: number;
  readonly _sleeper: BackoffSleeper;

  constructor(init: {
    attempts?: number;
    base_delay?: number;
    max_delay?: number;
    sleeper?: BackoffSleeper | null;
  } = {}) {
    this.attempts = init.attempts ?? 3;
    this.base_delay = init.base_delay ?? 1.0;
    this.max_delay = init.max_delay ?? 10.0;
    this._sleeper = init.sleeper ?? _default_sleeper;
    Object.freeze(this);
  }
}

/** 第 attempt 次（0 起 = 已失败次数）重试前的退避毫秒数。 */
export function backoff_delay_ms(policy: RetryPolicy, attempt: number): number {
  const delay = Math.min(policy.base_delay * 2 ** attempt, policy.max_delay);
  return delay * 1000;
}

/** 指数退避睡眠（attempt = 已失败次数，0 起；计时经 policy 注入的 sleeper）。 */
export async function retry_backoff(policy: RetryPolicy, attempt: number): Promise<void> {
  await policy._sleeper(backoff_delay_ms(policy, attempt));
}
