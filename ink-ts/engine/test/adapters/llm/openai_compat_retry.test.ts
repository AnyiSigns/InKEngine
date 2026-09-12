/**
 * OpenAI 兼容适配器单测：瞬时故障指数退避重试（Python test_llm_openai_compat.py
 * TestTransientRetry 子集移植，零真实网络）。
 *
 * 重试唯一权威：适配器默认单次尝试——重试经构造参数显式注入 RetryPolicy
 * （kernel/llm/fallback，独立直用场景）或由链级 ModelChain 统一负责；
 * 骨架/退避共享见 adapters/llm/retry_once.ts（三适配器同一循环）。
 */
import { describe, expect, it } from 'vitest';

import { collect_result } from '../../../src/dock/ports/llm.js';
import { user } from '../../../src/model/llm/messages.js';
import {
  LLMAuthError,
  LLMRateLimitError,
  LLMServerError,
} from '../../../src/model/llm/errors.js';
import { RetryPolicy } from '../../../src/loop/llm/fallback.js';
import type { LlmResponse } from '../../../src/adapters/llm/fetch_transport.js';
import {
  capture,
  error_json,
  make_adapter,
  ok_json,
  stream_response,
  sse_delta,
} from './compat_helpers.js';

const QUICK = new RetryPolicy({ attempts: 3, base_delay: 0.01, max_delay: 0.05 });

describe('瞬时故障重试（显式注入 RetryPolicy）', () => {
  it('ainvoke 503 重试后成功', async () => {
    let n = 0;
    const { llm, seen } = make_adapter(() => {
      n += 1;
      if (n < 3) return error_json(503, { error: { message: '服务暂时不可用' } });
      return ok_json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    }, {}, QUICK);
    const result = await llm.ainvoke([user('hi')]);
    expect(result.content).toBe('ok');
    expect(seen.calls).toBe(3);
  });

  it('重试耗尽抛最后一次错误', async () => {
    const { llm, seen } = make_adapter(
      () => error_json(429, { error: { message: 'rate limit' } }),
      {},
      QUICK,
    );
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect(seen.calls).toBe(3);
  });

  it('确定性错误（认证失败）不重试', async () => {
    const { llm, seen } = make_adapter(
      () => error_json(401, { error: { message: 'invalid key' } }),
      {},
      QUICK,
    );
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMAuthError);
    expect(seen.calls).toBe(1);
  });

  it('astream 空流重试后成功', async () => {
    let n = 0;
    const { llm, seen } = make_adapter(() => {
      n += 1;
      if (n < 3) return stream_response([]);
      return stream_response([sse_delta({ content: 'hi' })].map((d) => `data: ${JSON.stringify(d)}\n\n`));
    }, {}, QUICK);
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('hi');
    expect(seen.calls).toBe(3);
  });

  it('已产出内容后中断不重试（防重复帧）', async () => {
    const { llm, seen } = make_adapter(() => {
      const response: LlmResponse = {
        status: 200,
        body_text: async () => '',
        json: async () => {
          throw new Error('非流式路径不可 json');
        },
        async *aiter_lines(): AsyncIterable<string> {
          yield `data: ${JSON.stringify(sse_delta({ content: '部分' }))}\n`;
          throw new LLMServerError('', 'midstream');
        },
      };
      return response;
    }, {}, QUICK);
    const err = await capture(collect_result(llm.astream([user('hi')])));
    expect(err).toBeInstanceOf(LLMServerError);
    expect(seen.calls).toBe(1); // 已产出内容后中断：不重试（防重复帧）
  });

  it('默认单次尝试：瞬时故障直接抛错不叠加重试', async () => {
    let n = 0;
    const { llm, seen } = make_adapter(() => {
      n += 1;
      return error_json(503, { error: { message: '服务暂时不可用' } });
    }); // 未注入 retry
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMServerError);
    expect(seen.calls).toBe(1); // 单次尝试，无重试
  });
});
