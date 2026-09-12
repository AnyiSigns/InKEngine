// P6 归位（引擎重排计划 §6 P6 动作 D）：RetryPolicy 自 loop/llm/fallback.ts 下移
// model——重试参数纯数据形态（adapters llm 直引），fallback.ts 经 re-export 保链。
/** 重试策略（每次调用，与备用切换叠加）。 */
export class RetryPolicy {
  readonly attempts: number;
  readonly base_delay: number;
  readonly max_delay: number;

  constructor(init: { attempts?: number; base_delay?: number; max_delay?: number } = {}) {
    this.attempts = init.attempts ?? 3;
    this.base_delay = init.base_delay ?? 1.0;
    this.max_delay = init.max_delay ?? 10.0;
    Object.freeze(this);
  }
}

/** 第 n 次重试前的退避秒数（n 从 1 起：base_delay * 2^(n-1)，封顶 max_delay）。 */
export function _backoff_delay(policy: RetryPolicy, n: number): number {
  return Math.min(policy.base_delay * 2 ** (n - 1), policy.max_delay);
}
