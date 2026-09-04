/**
 * ModelChain 单测共享脚本夹具（Python test_llm_retry_fallback.py 的 ScriptedLLM
 * + make_chain + 可控 sleeper 缝移植）。
 *
 * ScriptedLLM 按脚本顺序产出调用结果：Error 实例 = 抛出；LLMResult = 成功；
 * 流式列表逐项产出（表项可为 Error，中途抛）；INFINITE_STREAM = 无限流（取消
 * 语义测试专用，yield 后经注入 tick 挂起——模拟真实流式的 await 点，中断可从
 * 该点注入）。真实适配器由宿主结构性装配，测试一律注入 fakes，零网络。
 */
import {
  AsyncLLM,
  LLMChunk,
  LLMConfig,
  LLMResult,
} from '../../../src/core/llm/base.js';
import { ModelChain, type RetryPolicy } from '../../../src/core/llm/fallback.js';
import type { Message } from '../../../src/core/llm/messages.js';

/** 退避睡眠注入面（秒）。 */
export type Sleeper = (seconds: number) => Promise<void>;

/** 哨兵：无限流脚本（取消语义测试专用）。 */
export const INFINITE_STREAM = Symbol('scripted.infinite_stream');

/** 非流式脚本：Error = 抛出；LLMResult = 成功；越界取末项（恒失败/恒成功）。 */
export type AinvokeScript = readonly (LLMResult | Error)[];

/** 流式脚本：Error = 首块前抛；chunk 列表逐项产出（可为空流）；INFINITE = 无限。 */
export type AstreamScript = readonly (
  | typeof INFINITE_STREAM
  | Error
  | readonly (LLMChunk | Error)[]
)[];

/** 无限流 yield 后的挂起缝（无 = 不挂起）。 */
export interface ScriptedLLMOptions {
  ainvoke_outcomes?: AinvokeScript | null;
  astream_outcomes?: AstreamScript | null;
  tick?: Sleeper | null;
}

/** 按脚本顺序产出调用结果的假适配器（零网络，确定性）。 */
export class ScriptedLLM extends AsyncLLM {
  override readonly adapter = 'scripted';

  private readonly _ainvoke_outcomes: AinvokeScript | null;
  private readonly _astream_outcomes: AstreamScript | null;
  private readonly _tick: Sleeper | null;
  ainvoke_calls = 0;
  astream_calls = 0;
  aclosed = false;

  constructor(config: LLMConfig, options: ScriptedLLMOptions = {}) {
    super(config);
    this._ainvoke_outcomes = options.ainvoke_outcomes ?? null;
    this._astream_outcomes = options.astream_outcomes ?? null;
    this._tick = options.tick ?? null;
  }

  override async aclose(): Promise<void> {
    this.aclosed = true;
  }

  private _script<T>(scripts: readonly T[] | null, calls: number): T | null {
    if (scripts === null || scripts.length === 0) return null;
    return scripts[Math.min(scripts.length - 1, calls - 1)]!;
  }

  override async ainvoke(messages: readonly Message[]): Promise<LLMResult> {
    this.ainvoke_calls += 1;
    const outcome = this._script<AinvokeScript[number]>(this._ainvoke_outcomes, this.ainvoke_calls);
    if (outcome === null) return new LLMResult({ content: 'ok' });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  override async *astream(messages: readonly Message[]): AsyncGenerator<LLMChunk> {
    this.astream_calls += 1;
    const outcome = this._script<AstreamScript[number]>(this._astream_outcomes, this.astream_calls);
    if (outcome === INFINITE_STREAM) {
      while (true) {
        yield new LLMChunk({ token: 'x' });
        if (this._tick !== null) await this._tick(0);
      }
    }
    if (outcome === null) {
      yield new LLMChunk({ token: 'ok' });
      return;
    }
    if (outcome instanceof Error) throw outcome;
    for (const item of outcome) {
      if (item instanceof Error) throw item;
      yield item;
    }
  }
}

/** 双模型链（a 主 + b 备），返回 (chain, {model_id: llm})。 */
export interface MakeChainOptions {
  retry?: RetryPolicy | null;
  a_stream?: AstreamScript | null;
  b_stream?: AstreamScript | null;
  sleep?: Sleeper | null;
  tick?: Sleeper | null;
}

const NOOP_SLEEP: Sleeper = async (): Promise<void> => {};

export function make_chain(
  a_outcomes: AinvokeScript,
  b_outcomes: AinvokeScript,
  options: MakeChainOptions = {},
): { chain: ModelChain; made: Record<string, ScriptedLLM> } {
  const configs = [
    new LLMConfig({ adapter: 'scripted', model_id: 'a', base_url: 'http://a' }),
    new LLMConfig({ adapter: 'scripted', model_id: 'b', base_url: 'http://b' }),
  ];
  const made: Record<string, ScriptedLLM> = {};

  function create(cfg: LLMConfig): ScriptedLLM {
    const llm = new ScriptedLLM(cfg, {
      ainvoke_outcomes: cfg.model_id === 'a' ? a_outcomes : b_outcomes,
      astream_outcomes: cfg.model_id === 'a' ? options.a_stream ?? null : options.b_stream ?? null,
      tick: options.tick ?? null,
    });
    made[cfg.model_id] = llm;
    return llm;
  }

  const chain = new ModelChain(configs, {
    retry: options.retry ?? null,
    create,
    sleep: options.sleep ?? NOOP_SLEEP,
  });
  return { chain, made };
}

/** 确定性 sleeper：把每次睡眠登记到 pending，测试按需 resolve/reject。 */
export interface PendingSleep {
  resolve: () => void;
  reject: (err: unknown) => void;
}

export function make_sleeper(): { sleep: Sleeper; pending: PendingSleep[] } {
  const pending: PendingSleep[] = [];
  const sleep: Sleeper = (seconds: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  return { sleep, pending };
}

/** 轮询等待条件成立（确定性测试不依赖真实退避计时）。 */
export async function wait_until(cond: () => boolean, timeout_ms = 2000): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('wait_until 超时');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** 排空整个流（取消/失败语义测试）。 */
export async function drain(stream: AsyncIterable<LLMChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // 消费丢弃
  }
}

/** 收集流式 token（成功路径断言）。 */
export async function collect_tokens(stream: AsyncIterable<LLMChunk>): Promise<string[]> {
  const tokens: string[] = [];
  for await (const chunk of stream) tokens.push(chunk.token ?? '');
  return tokens;
}

/** 收集流直至出错：返回已收 token 与首个错误（产出后中断路径断言）。 */
export async function collect_until_error(
  stream: AsyncIterable<LLMChunk>,
): Promise<{ tokens: string[]; error: unknown }> {
  const tokens: string[] = [];
  let error: unknown = null;
  try {
    for await (const chunk of stream) tokens.push(chunk.token ?? '');
  } catch (exc) {
    error = exc;
  }
  return { tokens, error };
}
