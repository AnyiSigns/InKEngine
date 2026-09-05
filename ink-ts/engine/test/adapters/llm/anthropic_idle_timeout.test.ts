/**
 * Anthropic fetch 传输逐读空闲超时单测（fake fetch seam，零真实网络）：
 * 流式读块间停顿超过 timeout_ms 即中止（AbortController），错误归
 * TimeoutError（供 classify_llm_error 映射为 LLMTimeoutError 后可重试）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  fetch_transport,
  type LlmPostRequest,
} from '../../../src/adapters/llm/anthropic_transport.js';

/** fetch 注入面（seam 类型未导出：经构造参数反推）。 */
type FetchImpl = NonNullable<Parameters<typeof fetch_transport>[0]>;

/** 假 fetch：头部即时返回；流体 = 首块后挂起直至 signal abort。 */
function stalled_stream_fetch(): { fetch_impl: FetchImpl; aborted: () => boolean } {
  let aborted = false;
  let reads = 0;
  const pendingRejects: Array<(err: Error) => void> = [];
  const encoder = new TextEncoder();
  type ReadResult = { done: boolean; value?: Uint8Array };
  const body: { getReader(): { read(): Promise<ReadResult>; cancel(): Promise<void> } } = {
    getReader: () => ({
      read: (): Promise<ReadResult> => {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve({ done: false, value: encoder.encode('first\n') });
        }
        // 后续读挂起，idle 超时 abort 时以 AbortError 拒绝
        return new Promise<ReadResult>((_resolve, reject) => {
          pendingRejects.push(reject as (err: Error) => void);
        });
      },
      cancel: async () => undefined,
    }),
  };
  const fetch_impl: FetchImpl = async (_url, init) => {
    const signal = (init as { signal?: AbortSignal | undefined }).signal;
    signal?.addEventListener('abort', () => {
      aborted = true;
      const err = new Error('aborted');
      err.name = 'AbortError';
      for (const reject of pendingRejects.splice(0)) reject(err);
    });
    return { status: 200, body, text: async () => 'first' };
  };
  return { fetch_impl, aborted: () => aborted };
}

const REQUEST: LlmPostRequest = { headers: {}, json: {}, timeout_ms: 1000 };

describe('fetch 传输逐读空闲超时', () => {
  it('流式块间停顿超 timeout_ms → 中止并抛 TimeoutError', async () => {
    vi.useFakeTimers();
    try {
      const { fetch_impl, aborted } = stalled_stream_fetch();
      const transport = fetch_transport(fetch_impl);
      const response = await transport.post('https://llm.example/messages', REQUEST);
      const iterator = response.aiter_lines()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(String(first.value)).toBe('first');
      // 第二次读挂起：advance 触发 idle 超时 → abort → 拒绝（每读重新武装语义）
      const second = iterator.next();
      second.catch(() => undefined); // 预挂处理兜底（advance 内即拒绝，防 unhandled 竞态）
      await vi.advanceTimersByTimeAsync(1100);
      await expect(second).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(aborted()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
