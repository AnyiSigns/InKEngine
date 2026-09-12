/**
 * LLM 适配器重试骨架共享模块单测（retry_once.ts）：退避序列 0 基（适配器
 * attempt = 已失败次数）与 kernel/llm/fallback ModelChain 的 1 基内部计数
 * （n = 失败次数 + 1）产出同一序列的等价性、预算边界与注入 sleeper 录制。
 */
import { describe, expect, it } from 'vitest';

import { RetryPolicy } from '../../../src/loop/llm/fallback.js';
import { LLMNetworkError, LLMServerError } from '../../../src/model/llm/errors.js';
import {
  backoff_delay_ms,
  retry_attempts,
  with_retry,
  with_stream_retry,
  type Sleeper,
} from '../../../src/adapters/llm/retry_once.js';

/** 0 基与 1 基计数的同一序列：min(base*2^attempt, max) === min(base*2^(n-1), max)。 */
function expected_sequence(policy: RetryPolicy, max_retries: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= max_retries; n++) {
    out.push(Math.min(policy.base_delay * 2 ** (n - 1), policy.max_delay) * 1000);
  }
  return out;
}

function make_recorder(): { sleep: Sleeper; sleeps: number[] } {
  const sleeps: number[] = [];
  const sleep: Sleeper = async (seconds: number): Promise<void> => {
    sleeps.push(Math.round(seconds * 1000));
  };
  return { sleep, sleeps };
}

describe('retry_once 退避语义', () => {
  it('attempt（0 基 = 已失败次数）产出与 1 基计数相同的退避序列', async () => {
    const policy = new RetryPolicy({ attempts: 5, base_delay: 1, max_delay: 8 });
    const { sleep, sleeps } = make_recorder();
    let failures = 3;
    await with_retry(
      policy,
      async () => {
        if (failures > 0) {
          failures -= 1;
          throw new LLMServerError('', '服务暂时不可用');
        }
        return 'ok';
      },
      { sleep },
    );
    expect(sleeps).toEqual(expected_sequence(policy, 3)); // 3 次失败 = 3 次退避
  });

  it('封顶 max_delay：长退避序列不越过上限', () => {
    const policy = new RetryPolicy({ attempts: 6, base_delay: 1, max_delay: 3 });
    expect(backoff_delay_ms(policy, 0)).toBe(1000);
    expect(backoff_delay_ms(policy, 1)).toBe(2000);
    expect(backoff_delay_ms(policy, 2)).toBe(3000);
    expect(backoff_delay_ms(policy, 3)).toBe(3000); // 封顶
  });

  it('null 策略 = 单次尝试（预算 1），瞬时故障不叠加重试', async () => {
    const { sleep, sleeps } = make_recorder();
    let calls = 0;
    await expect(
      with_retry(
        null,
        async () => {
          calls += 1;
          throw new LLMNetworkError('', '网络错误');
        },
        { sleep },
      ),
    ).rejects.toBeInstanceOf(LLMNetworkError);
    expect(calls).toBe(1);
    expect(retry_attempts(null)).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('with_stream_retry：首块前瞬时失败重试，产出后失败不重试', async () => {
    const policy = new RetryPolicy({ attempts: 3, base_delay: 0.001 });
    let calls = 0;
    const gen = with_stream_retry(
      policy,
      () =>
        (async function* generate() {
          calls += 1;
          if (calls === 1) throw new LLMNetworkError('', '网络错误');
          yield { token: 'x' };
          throw new LLMServerError('', 'midstream'); // 产出后失败：不得重试
        })(),
    );
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const item of gen) chunks.push(item.token ?? '');
      })(),
    ).rejects.toBeInstanceOf(LLMServerError);
    expect(chunks.join('')).toBe('x');
    expect(calls).toBe(2); // 首块前重试一次；产出后失败不再重试
  });
});
