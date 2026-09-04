/**
 * 重试/退避/备用切换/流式中断（ModelChain）单测——Python
 * test_llm_retry_fallback.py 的 TS 移植（脚本夹具见 ./fallback_helpers.ts）。
 *
 * 零网络、确定性验证（注入 sleeper 缝替代真实退避计时）：
 * - 瞬时故障指数退避重试（流式仅首块前重试）；
 * - 确定性失败不重试；
 * - 重试耗尽切备用模型（ainvoke 与 astream 首块前失败）；
 * - 流式产出后失败不切换（防重复内容）；
 * - 链全部失败抛最后一次错误；
 * - 取消语义：非 LLMError 中断原样穿透不吞（TS 表达 Python CancelledError
 *   语义：链只消化 LLMError，宿主取消/注入中断一律上抛）。
 */
import { describe, expect, it } from 'vitest';

import { LLMChunk, LLMConfig, LLMResult } from '../../../src/core/llm/base.js';
import {
  LLMAuthError,
  LLMBadRequestError,
  LLMConfigError,
  LLMNetworkError,
  LLMServerError,
  LLMTimeoutError,
} from '../../../src/core/llm/errors.js';
import { ModelChain, RetryPolicy } from '../../../src/core/llm/fallback.js';
import { user } from '../../../src/core/llm/messages.js';
import {
  INFINITE_STREAM,
  ScriptedLLM,
  collect_tokens,
  collect_until_error,
  drain,
  make_chain,
  make_sleeper,
  wait_until,
} from './fallback_helpers.js';

const QUICK = new RetryPolicy({ attempts: 3, base_delay: 0.01, max_delay: 0.05 });

/** 取消哨兵错误（非 LLMError：链必须原样穿透，等价 Python CancelledError）。 */
class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

describe('TestRetryAinvoke', () => {
  it('瞬时故障退避重试后成功（3 次尝试耗尽前转好）', async () => {
    const { chain, made } = make_chain([new LLMTimeoutError()], [], { retry: QUICK });
    const result = await chain.ainvoke([user('hi')]);
    expect(result.content).toBe('ok');
    expect(made['a']!.ainvoke_calls).toBe(3);
  });

  it('退避重试计数：主备均带完整重试预算', async () => {
    const { chain, made } = make_chain([new LLMNetworkError()], [new LLMNetworkError()], {
      retry: QUICK,
    });
    await expect(chain.ainvoke([user('hi')])).rejects.toBeInstanceOf(LLMNetworkError);
    expect(made['a']!.ainvoke_calls).toBe(3);
    expect(made['b']!.ainvoke_calls).toBe(3);
  });

  it('重试耗尽切备用模型', async () => {
    const { chain, made } = make_chain(
      [new LLMTimeoutError()],
      [new LLMResult({ content: '备用成功' })],
      { retry: QUICK },
    );
    const result = await chain.ainvoke([user('hi')]);
    expect(result.content).toBe('备用成功');
    expect(made['a']!.ainvoke_calls).toBe(3);
    expect(made['b']!.ainvoke_calls).toBe(1);
  });

  it('链全部失败抛最后一次错误', async () => {
    const { chain } = make_chain([new LLMTimeoutError()], [new LLMServerError()], {
      retry: QUICK,
    });
    await expect(chain.ainvoke([user('hi')])).rejects.toBeInstanceOf(LLMServerError);
  });

  it('认证失败 fail-closed：不重试不切备用，直接上抛', async () => {
    const { chain, made } = make_chain([new LLMAuthError()], [], {
      retry: new RetryPolicy({ attempts: 1, base_delay: 0.01 }),
    });
    await expect(chain.ainvoke([user('hi')])).rejects.toBeInstanceOf(LLMAuthError);
    expect(made['a']!.ainvoke_calls).toBe(1);
    expect(made['b']).toBeUndefined();
  });

  it('非认证确定性失败不重试但仍切备用（配置兜底）', async () => {
    const { chain, made } = make_chain(
      [new LLMBadRequestError()],
      [new LLMResult({ content: '备用成功' })],
      { retry: QUICK },
    );
    const result = await chain.ainvoke([user('hi')]);
    expect(result.content).toBe('备用成功');
    expect(made['a']!.ainvoke_calls).toBe(1);
    expect(made['b']!.ainvoke_calls).toBe(1);
  });

  it('流式认证失败同样 fail-closed：不切备用', async () => {
    const { chain, made } = make_chain([], [], {
      retry: QUICK,
      a_stream: [new LLMAuthError()],
    });
    await expect(drain(chain.astream([user('hi')]))).rejects.toBeInstanceOf(LLMAuthError);
    expect(made['b']).toBeUndefined();
  });

  it('退避睡眠中取消：取消穿透不重试（确定性 sleeper 缝）', async () => {
    const { sleep, pending } = make_sleeper();
    const { chain, made } = make_chain([new LLMTimeoutError()], [], {
      retry: new RetryPolicy({ attempts: 3, base_delay: 30.0, max_delay: 30.0 }),
      sleep,
    });
    const task = chain.ainvoke([user('hi')]);
    await wait_until(() => pending.length > 0);
    pending[0]!.reject(new CancelledError());
    await expect(task).rejects.toBeInstanceOf(CancelledError);
    expect(made['a']!.ainvoke_calls).toBe(1); // 取消穿透，不再重试
  });
});

describe('TestRetryAstream', () => {
  it('流式仅首块前重试：首次首块前失败，第二次正常流', async () => {
    const { chain, made } = make_chain([], [], {
      retry: QUICK,
      a_stream: [new LLMNetworkError(), [new LLMChunk({ token: '好' })]],
    });
    const tokens = await collect_tokens(chain.astream([user('hi')]));
    expect(tokens).toEqual(['好']);
    expect(made['a']!.astream_calls).toBe(2);
  });

  it('产出后失败不重试不切换，直接上抛（防重复内容）', async () => {
    const { chain, made } = make_chain([], [], {
      retry: QUICK,
      a_stream: [[new LLMChunk({ token: '前' }), new LLMNetworkError()]],
    });
    const { tokens, error } = await collect_until_error(chain.astream([user('hi')]));
    expect(tokens).toEqual(['前']);
    expect(error).toBeInstanceOf(LLMNetworkError);
    expect(made['a']!.astream_calls).toBe(1);
    expect(made['b']).toBeUndefined();
  });

  it('首块前失败切备用模型', async () => {
    const { chain, made } = make_chain([], [], {
      retry: QUICK,
      a_stream: [new LLMTimeoutError()],
      b_stream: [[new LLMChunk({ token: '备用流' })]],
    });
    const tokens = await collect_tokens(chain.astream([user('hi')]));
    expect(tokens).toEqual(['备用流']);
    expect(made['a']!.astream_calls).toBe(3);
    expect(made['b']!.astream_calls).toBe(1);
  });

  it('流式链全部失败抛最后一次错误', async () => {
    const { chain } = make_chain([], [], {
      retry: QUICK,
      a_stream: [new LLMTimeoutError()],
      b_stream: [new LLMServerError()],
    });
    await expect(drain(chain.astream([user('hi')]))).rejects.toBeInstanceOf(LLMServerError);
  });

  it('无限流中取消：非 LLMError 中断原样穿透（不切备用）', async () => {
    const { sleep: tick, pending } = make_sleeper();
    const { chain, made } = make_chain([], [], {
      retry: QUICK,
      a_stream: [INFINITE_STREAM],
      tick,
    });
    const task = drain(chain.astream([user('hi')]));
    await wait_until(() => pending.length > 0);
    pending[0]!.reject(new CancelledError());
    await expect(task).rejects.toBeInstanceOf(CancelledError);
    expect(made['a']!.astream_calls).toBe(1);
    expect(made['b']).toBeUndefined();
  });

  it('aclose 释放链上已创建的模型实例（幂等）', async () => {
    const { chain, made } = make_chain([], [], { retry: QUICK });
    await chain.ainvoke([user('hi')]);
    expect(made['a']).toBeDefined();
    await chain.aclose();
    expect(made['a']!.aclosed).toBe(true);
    await chain.aclose(); // 幂等
  });
});

describe('TestConfig', () => {
  it('空配置链构造即抛 LLMConfigError', () => {
    expect(() => new ModelChain([])).toThrow(LLMConfigError);
  });

  it('配置字典经 from_dict 规范化（未知键收 extra），备用模型惰性构建', async () => {
    const made: LLMConfig[] = [];
    const chain = new ModelChain(
      [
        new LLMConfig({ adapter: 'a', model_id: 'm', base_url: 'http://x' }),
        { adapter: 'b', model_id: 'n', base_url: 'http://y', future_field: 1 },
      ],
      {
        create: (cfg: LLMConfig): ScriptedLLM => {
          made.push(cfg);
          return new ScriptedLLM(cfg);
        },
      },
    );
    expect(chain.configs).toHaveLength(2);
    expect(chain.configs[1]).toBeInstanceOf(LLMConfig);
    expect(chain.configs[1]!.model_id).toBe('n');
    expect(chain.configs[1]!.extra).toEqual({ future_field: 1 });
    const result = await chain.ainvoke([user('hi')]);
    expect(result.content).toBe('ok');
    expect(made).toHaveLength(1); // 备用模型惰性构建：只建被用到的
    expect(made[0]!.model_id).toBe('m');
  });

  it('未注入工厂时惰性抛 LLMConfigError（装配方需注入 create）', async () => {
    const chain = new ModelChain([
      new LLMConfig({ adapter: 'x', model_id: 'm', base_url: 'http://x' }),
    ]);
    await expect(chain.ainvoke([user('hi')])).rejects.toBeInstanceOf(LLMConfigError);
  });
});
