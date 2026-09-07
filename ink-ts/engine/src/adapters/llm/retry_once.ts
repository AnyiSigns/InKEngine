/**
 * LLM 适配器瞬时故障重试骨架（openai_compat / openai_responses / anthropic
 * 三适配器共享，消除各自 attempts 循环 + is_transient + emitted 骨架漂移）。
 *
 * RetryPolicy 唯一权威 = kernel/llm/fallback.ts（数据形态，无 sleeper 字段，
 * 退避睡眠经本模块注入的 Sleeper 执行——测试注入录制/假时钟零真实等待，
 * 与 ModelChain 的 sleep 注入同构）。适配器默认单次尝试（retry=null），
 * 仅当独立直用注入策略时开指数退避重试——杜绝「适配器 × 链」双层叠加。
 *
 * 退避语义：attempt = 已失败次数（0 基），序列 min(base_delay*2^attempt,
 * max_delay)；core fallback 内部按 1 基计数 n = attempt + 1 得
 * min(base_delay*2^(n-1), max_delay)——两者产出同一序列，仅为计数基线
 * 记号差异（测试须覆盖两基线的等价性）。睡眠单位为秒（与 core fallback
 * 的 Sleeper 单位一致）。
 */
import { RetryPolicy } from '../../kernel/llm/fallback.js';
import {
  LLMError,
  classify_llm_error,
  is_transient_llm_error,
} from '../../kernel/llm/errors.js';

/** 退避睡眠注入面（seconds；缺省真实计时，测试注入录制 sleeper 覆盖）。 */
export type Sleeper = (seconds: number) => Promise<void>;

const _default_sleep: Sleeper = async (seconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
};

/** 重试预算：显式策略的 attempts（总尝试次数，含首次）；null = 单次。 */
export function retry_attempts(policy: RetryPolicy | null): number {
  return policy !== null ? Math.max(1, policy.attempts) : 1;
}

/** 第 attempt 次重试（0 基 = 已失败次数）前的退避毫秒数。 */
export function backoff_delay_ms(policy: RetryPolicy, attempt: number): number {
  const delay = Math.min(policy.base_delay * 2 ** attempt, policy.max_delay);
  return delay * 1000;
}

/** 退避睡眠（attempt = 已失败次数，0 基；计时经注入 sleeper）。 */
export async function sleep_backoff(
  policy: RetryPolicy,
  attempt: number,
  sleep: Sleeper = _default_sleep,
): Promise<void> {
  await sleep(backoff_delay_ms(policy, attempt) / 1000);
}

/** 统一异常分类（非 LLMError 兜底包装；LLMError 直通）。 */
export function to_llm_error(exc: unknown): LLMError {
  if (exc instanceof LLMError) return exc;
  if (exc instanceof Error) {
    return classify_llm_error(null, null, exc);
  }
  return classify_llm_error(null, null, new Error(String(exc)));
}

/**
 * 非流式重试循环：瞬时故障退避重试直至预算耗尽；确定性失败/非 LLMError
 * 中断原样上抛（不重试——宿主取消不得被骨架吞掉）。
 */
export async function with_retry<T>(
  policy: RetryPolicy | null,
  once: () => Promise<T>,
  opts: { sleep?: Sleeper } = {},
): Promise<T> {
  const sleep = opts.sleep ?? _default_sleep;
  const attempts = retry_attempts(policy);
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await once();
    } catch (exc) {
      if (
        !(exc instanceof LLMError) ||
        !is_transient_llm_error(exc) ||
        attempt + 1 >= attempts
      ) {
        throw exc;
      }
      await sleep_backoff(policy as RetryPolicy, attempt, sleep);
    }
  }
  throw new LLMError('LLM 调用未产生结果');
}

/**
 * 流式重试循环：每轮产出帧标记 emitted；已产出内容后失败不重试（重试会
 * 重复已消费帧），首块前瞬时故障退避重试直至预算耗尽。
 */
export async function* with_stream_retry<T>(
  policy: RetryPolicy | null,
  once: () => AsyncGenerator<T>,
  opts: { sleep?: Sleeper } = {},
): AsyncGenerator<T> {
  const sleep = opts.sleep ?? _default_sleep;
  const attempts = retry_attempts(policy);
  for (let attempt = 0; attempt < attempts; attempt++) {
    let emitted = false;
    try {
      for await (const item of once()) {
        emitted = true;
        yield item;
      }
      return;
    } catch (exc) {
      if (!(exc instanceof LLMError)) throw exc;
      if (emitted) throw exc; // 已产出内容后的中断不重试（防重复帧）
      if (!is_transient_llm_error(exc) || attempt + 1 >= attempts) throw exc;
      await sleep_backoff(policy as RetryPolicy, attempt, sleep);
    }
  }
  throw new LLMError('LLM 调用未产生结果');
}
