/** 引擎侧 LLM 链守卫包装单测——对标 pytest test_llm_guard.py。
 *
 * - UsageTrackingLLM：usage 帧 → 当前节点成本账（account_usage）+ llm_usage
 *   指标事件；节点上下文缺失/上报失败不阻断 LLM 流；
 * - CompressingLLM：触发阈值内零改动透传；触发后旧段折叠为确定性摘要
 *   （system 恒保留 + 保留尾段）；
 * - 执行器节点上下文注入（current_node_context）在节点执行期对 LLM 调用可见。
 *
 * 与 Python 差异：节点上下文以 AsyncLocalStorage 承载（等价 contextvars）；
 * 上报失败在 TS core 零日志纪律下静默忽略（Python 侧 logger.warning 不移植）。
 */

import { describe, expect, it } from 'vitest';

import {
  ThresholdCompressionPolicy,
} from '../../../src/core/context/context_compression.js';
import type { Message } from '../../../src/core/llm/messages.js';
import {
  assistant,
  system,
  user,
} from '../../../src/core/llm/messages.js';
import type {
  AsyncLLM,
  LLMChunk,
  LLMConfig,
  LLMResult,
  Usage,
} from '../../../src/core/llm/_guard_types.js';
import {
  CompressingLLM,
  UsageTrackingLLM,
  current_node_context,
} from '../../../src/core/llm/guard.js';

class RecordingLLM implements AsyncLLM {
  readonly adapter = 'recording';
  readonly config: LLMConfig = {
    adapter: 'recording',
    model_id: 'rec',
    base_url: 'http://rec',
  };
  received: Message[][] = [];
  aclosed = false;
  private readonly _stream_usage: Usage;
  private readonly _result_usage: Usage;

  constructor(opts: { stream_usage?: Usage; result_usage?: Usage } = {}) {
    this._stream_usage = opts.stream_usage ?? null;
    this._result_usage = opts.result_usage ?? null;
  }

  async ainvoke(messages: readonly Message[]): Promise<LLMResult> {
    this.received.push([...messages]);
    return { content: 'ok', usage: this._result_usage ?? undefined };
  }

  async *astream(messages: readonly Message[]): AsyncGenerator<LLMChunk> {
    this.received.push([...messages]);
    yield { token: 'ok' };
    if (this._stream_usage) yield { usage: this._stream_usage };
  }

  async aclose(): Promise<void> {
    this.aclosed = true;
  }
}

class FakeCtx {
  accounted: Array<Record<string, unknown>> = [];
  events: Array<[string, Record<string, unknown>]> = [];

  account_usage(usage: Record<string, unknown>): void {
    this.accounted.push(usage);
  }

  async emit(etype: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push([etype, payload]);
  }
}

/** n 条历史消息（交替 user/assistant，各 chars 字符）+ system 链首。 */
function long_history(n: number, chars: number = 20): Message[] {
  const messages: Message[] = [system('系统提示')];
  for (let i = 0; i < n; i += 1) {
    messages.push(user(`u${i}` + 'x'.repeat(chars)));
    messages.push(assistant('a' + 'y'.repeat(chars)));
  }
  return messages;
}

async function collect(stream: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
  const chunks: LLMChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

// 默认策略（30 条/160000 字符，0.8 × 200k 兜底窗口）触发所需的历史规模：
// 100 轮 × 1000 字符 ≈ 200k 字符 ≥ 字符阈值
const DEFAULT_TRIGGER_HISTORY = long_history(100, 1000);

describe('UsageTrackingLLM（用量闭环）', () => {
  it('ainvoke 记账并发射 llm_usage 事件', async () => {
    const inner = new RecordingLLM({ result_usage: { prompt_tokens: 5, completion_tokens: 3 } });
    const llm = new UsageTrackingLLM(inner);
    const ctx = new FakeCtx();
    const token = current_node_context.set(ctx);
    let result: LLMResult;
    try {
      result = await llm.ainvoke([user('hi')]);
    } finally {
      current_node_context.reset(token);
    }
    expect(result.content).toBe('ok');
    expect(ctx.accounted).toEqual([{ prompt_tokens: 5, completion_tokens: 3 }]);
    expect(ctx.events).toContainEqual(['llm_usage', { prompt_tokens: 5, completion_tokens: 3 }]);
  });

  it('astream 捕获流式末帧 usage', async () => {
    const inner = new RecordingLLM({ stream_usage: { prompt_tokens: 7, completion_tokens: 2 } });
    const llm = new UsageTrackingLLM(inner);
    const ctx = new FakeCtx();
    const token = current_node_context.set(ctx);
    let chunks: LLMChunk[];
    try {
      chunks = await collect(llm.astream([user('hi')]));
    } finally {
      current_node_context.reset(token);
    }
    expect(chunks.map((c) => c.token).filter((t): t is string => Boolean(t))).toEqual(['ok']);
    expect(ctx.accounted).toEqual([{ prompt_tokens: 7, completion_tokens: 2 }]);
    expect(ctx.events).toContainEqual(['llm_usage', { prompt_tokens: 7, completion_tokens: 2 }]);
  });

  it('节点上下文缺失（节点外调用）静默跳过，不阻断 LLM 流', async () => {
    const inner = new RecordingLLM({ stream_usage: { prompt_tokens: 1 } });
    const llm = new UsageTrackingLLM(inner);
    const chunks = await collect(llm.astream([user('hi')]));
    expect(chunks.map((c) => c.token).filter((t): t is string => Boolean(t))).toEqual(['ok']);
  });

  it('上报失败（account_usage 抛错）不阻断 LLM 调用', async () => {
    const inner = new RecordingLLM({ result_usage: { prompt_tokens: 1 } });

    class BadCtx {
      account_usage(_usage: Record<string, unknown>): void {
        throw new Error('记账失败');
      }

      async emit(_etype: string, _payload: Record<string, unknown>): Promise<void> {
        throw new Error('事件失败');
      }
    }

    const llm = new UsageTrackingLLM(inner);
    const token = current_node_context.set(new BadCtx());
    let result: LLMResult;
    try {
      result = await llm.ainvoke([user('hi')]);
    } finally {
      current_node_context.reset(token);
    }
    expect(result.content).toBe('ok');
  });

  it('转发 aclose 到内层模型', async () => {
    const inner = new RecordingLLM();
    const llm = new UsageTrackingLLM(inner);
    await llm.aclose();
    expect(inner.aclosed).toBe(true);
  });
});

describe('CompressingLLM（回合内上下文压缩）', () => {
  it('未达阈值时原样透传零改动', () => {
    const messages = long_history(5, 10); // 11 条 × 10 字 → 双阈值均不达
    const inner = new RecordingLLM();
    const llm = new CompressingLLM(inner);
    const result = llm._apply(messages);
    expect(result).toEqual([...messages]);
    expect(result.length).toBe(messages.length);
  });

  it('达阈值时折叠旧段为摘要并保留尾段', () => {
    const messages = DEFAULT_TRIGGER_HISTORY; // 201 条 × ~1000 字 → 双阈值触发
    const inner = new RecordingLLM();
    const llm = new CompressingLLM(inner, { keep_recent: 6 });
    const result = llm._apply(messages);
    expect(result.length).toBeLessThan(messages.length); // 折叠生效
    // system 恒保留 + 摘要 + 最近 6 条保留
    expect(result[0]).toEqual(messages[0]);
    expect(result[0]!.role).toBe('system');
    const summary = result[1]!;
    expect(summary.role).toBe('user');
    expect(summary.content).toContain('历史上下文压缩摘要');
    // 最近消息原样保留（含原文）
    expect(result.slice(-6)).toEqual(messages.slice(-6));
  });

  it('摘要确定性可复现', () => {
    const messages = DEFAULT_TRIGGER_HISTORY;
    const llm = new CompressingLLM(new RecordingLLM(), { keep_recent: 6 });
    const first = llm._apply(messages);
    const second = llm._apply(messages);
    expect(first.map((m) => m.content)).toEqual(second.map((m) => m.content));
  });

  it('自定义策略阈值生效', () => {
    const strict = new ThresholdCompressionPolicy({ min_messages: 5, min_chars: 100 });
    const messages = long_history(3, 30); // 7 条 × 30 字 ≥ 双阈值
    const inner = new RecordingLLM();
    const llm = new CompressingLLM(inner, { policy: strict, keep_recent: 2 });
    const result = llm._apply(messages);
    expect(result.length).toBeLessThan(messages.length);
  });

  it('ainvoke 转发压缩后的消息流', async () => {
    const messages = DEFAULT_TRIGGER_HISTORY;
    const inner = new RecordingLLM();
    const llm = new CompressingLLM(inner, { keep_recent: 6 });
    await llm.ainvoke(messages);
    expect(inner.received.length).toBe(1);
    const forwarded = inner.received[0]!;
    expect(forwarded.length).toBeLessThan(messages.length);
    expect(forwarded.slice(-6)).toEqual(messages.slice(-6));
  });

  it('astream 未触发时原样透传', async () => {
    const messages = long_history(2, 5); // 5 条 × 5 字 → 不触发
    const inner = new RecordingLLM();
    const llm = new CompressingLLM(inner);
    const chunks = await collect(llm.astream(messages));
    expect(chunks.map((c) => c.token).filter((t): t is string => Boolean(t))).toEqual(['ok']);
    expect(inner.received[0]).toEqual([...messages]);
  });

  it('转发 aclose 到内层模型', async () => {
    const inner = new RecordingLLM();
    const llm = new CompressingLLM(inner);
    await llm.aclose();
    expect(inner.aclosed).toBe(true);
  });
});
