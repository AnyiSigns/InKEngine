/**
 * Anthropic 适配器重试单测（瞬时故障指数退避重试，镜像 openai_compat 的
 * TestTransientRetry 形态）：重试唯一权威 = 注入的 RetryPolicy（默认 null =
 * 单次尝试，瞬时故障直接上抛不叠加重试）；退避经策略注入的假时钟/录制
 * sleeper 执行——零真实睡眠、确定性断言退避序列。
 */
import { describe, expect, it } from 'vitest';

import { collect_result } from '../../../src/core/llm/base.js';
import {
  LLMAuthError,
  LLMRateLimitError,
  LLMServerError,
} from '../../../src/core/llm/errors.js';
import { user } from '../../../src/core/llm/messages.js';
import { RetryPolicy } from '../../../src/adapters/llm/retry.js';
import {
  error_json,
  make_anthropic,
  ok_json,
  sse_frame,
  stream_response,
} from './anthropic_helpers.js';

/** 录制式 sleeper 策略：退避毫秒数进 sleeps，零真实等待（假时钟注入面）。 */
function recording_policy(init: { attempts?: number; base_delay?: number; max_delay?: number } = {}) {
  const sleeps: number[] = [];
  const policy = new RetryPolicy({
    ...init,
    sleeper: async (ms: number): Promise<void> => {
      sleeps.push(ms);
    },
  });
  return { policy, sleeps };
}

async function capture<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (exc) {
    return exc;
  }
}

const OK_BODY = { content: [{ type: 'text', text: 'ok' }] };

describe('Anthropic 瞬时故障重试（显式注入 RetryPolicy）', () => {
  it('ainvoke 503 重试后成功（退避经注入 sleeper，零真实睡眠）', async () => {
    const { policy, sleeps } = recording_policy({ attempts: 3, base_delay: 1, max_delay: 4 });
    let n = 0;
    const { llm, seen } = make_anthropic(() => {
      n += 1;
      if (n < 3) return error_json(503, { error: { message: '服务暂时不可用' } });
      return ok_json(OK_BODY);
    }, {}, policy);
    const result = await llm.ainvoke([user('hi')]);
    expect(result.content).toBe('ok');
    expect(seen.calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]); // 指数退避 1s→2s，封顶 4s
  });

  it('重试耗尽抛最后一次错误（429 → LLMRateLimitError，退避序列完整）', async () => {
    const { policy, sleeps } = recording_policy({ attempts: 3, base_delay: 1, max_delay: 4 });
    const { llm, seen } = make_anthropic(
      () => error_json(429, { error: { message: 'rate limit' } }),
      {},
      policy,
    );
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect(seen.calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('确定性错误（认证失败）不重试', async () => {
    const { policy, sleeps } = recording_policy({ attempts: 3 });
    const { llm, seen } = make_anthropic(
      () => error_json(401, { error: { message: 'invalid key' } }),
      {},
      policy,
    );
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMAuthError);
    expect(seen.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('astream 空流重试后成功', async () => {
    const { policy } = recording_policy({ attempts: 3, base_delay: 0.001 });
    let n = 0;
    const { llm, seen } = make_anthropic(() => {
      n += 1;
      if (n < 3) return stream_response([]);
      return stream_response([
        sse_frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
        sse_frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      ]);
    }, {}, policy);
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('hi');
    expect(seen.calls).toBe(3);
  });

  it('默认单次尝试：瞬时故障直接抛错不叠加重试', async () => {
    let n = 0;
    const { llm, seen } = make_anthropic(() => {
      n += 1;
      return error_json(503, { error: { message: '服务暂时不可用' } });
    });
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMServerError);
    expect(seen.calls).toBe(1);
  });
});
