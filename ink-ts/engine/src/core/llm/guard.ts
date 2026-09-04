/**
 * 引擎侧 LLM 链守卫包装（guard.py 移植）：用量闭环 + 回合内上下文压缩。
 *
 * - UsageTrackingLLM：LLM usage 帧 → 当前节点成本账（ctx.account_usage）与
 *   llm_usage 指标事件（ctx.emit）——生产用量闭环接线：流式末帧 usage 与非流式
 *   result.usage 统一上报，不再只活在测试里；
 * - CompressingLLM：LLM 调用前按 CompressPolicy 压缩消息流——回合内上下文
 *   压缩：默认双阈值（30 条 / 160000 字符，引擎默认 ThresholdCompressionPolicy，
 *   构造参数可覆盖）触发，阈值与保留尾段长度可配，压缩是确定性非破坏视图
 *   （原始消息流不修改）。
 *
 * 节点上下文经 current_node_context（AsyncLocalStorage，等价 Python contextvars
 * 的 per-async 链隔离）由执行器在节点边界注入，包装层据此把用量记入正确的
 * 节点账并发射事件——包装层不依赖执行器具体类型（鸭子协议 account_usage/emit），
 * 节点外调用（null 上下文）时静默跳过，零影响。
 *
 * 落地差异：AsyncLLM 实时厂商传输（适配器注册/SSE 流解析/collect_result）属
 * llm base 批次，尚未随本模块移植——本模块是纯机制包装，内层模型（inner）
 * 由宿主注入（结构契约见 _guard_types.ts），缺省确定值。零 IO；Python 侧上报
 * 失败的 logger.warning 以静默忽略替代（core 零日志纪律，不阻断 LLM 调用）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  ThresholdCompressionPolicy,
  compress_message_history,
  type CompressionPolicy,
} from '../context/context_compression.js';

import type { Message } from './messages.js';
import type {
  AsyncLLM,
  InvokeOptions,
  LLMChunk,
  LLMConfig,
  LLMResult,
  Usage,
} from './_guard_types.js';

// 包装器协议形态的占位配置（不发网络调用；config 仅是 AsyncLLM 协议字段）。
const _GUARD_CONFIG: LLMConfig = {
  adapter: 'guard',
  model_id: 'engine-guard',
  base_url: 'http://guard.local',
};

// 执行器注入的当前节点上下文（节点边界设置，包装层读取；null = 节点外调用）。
// 定义在包装模块而非执行器：包装层读取、执行器写入，避免 llm ↔ executor
// 模块循环依赖（executor 顶层 import 本模块即可）。AsyncLocalStorage 承载
// per-async 链隔离（等价 contextvars 的 task-local 语义）。
const _storage = new AsyncLocalStorage<unknown>();

// 节点上下文注入令牌形态（镜像 Python ContextVar.set 返回的 token，reset 还原；
// _previous = set 前的上下文，undefined = 此前未设置，reset 时清空）。
interface ContextToken {
  readonly _previous: unknown | undefined;
}

/**
 * current_node_context：当前节点上下文（鸭子协议 account_usage/emit）。
 *
 * set(ctx) 返回 token，reset(token) 在节点边界收口时还原——与执行器的
 * 「注入 → 执行 → 还原」生命周期一一对应；用法镜像 Python contextvars。
 */
export const current_node_context = {
  /** 读取当前上下文（未注入/节点外 = null）。 */
  get(): unknown | null {
    const store = _storage.getStore();
    return store === undefined ? null : store;
  },

  /** 注入当前节点上下文（节点边界调用），返回还原 token。 */
  set(value: unknown | null): ContextToken {
    const previous = _storage.getStore();
    _storage.enterWith(value);
    return { _previous: previous };
  },

  /** 还原节点上下文（节点收口调用）。 */
  reset(token: ContextToken): void {
    if (token._previous === undefined) {
      _storage.disable();
    } else {
      _storage.enterWith(token._previous);
    }
  },
};

/** usage 帧 → 指标帧（prompt/completion tokens；缺项/非正值省略）。 */
function _usage_frame(usage: Record<string, unknown>): Record<string, number> {
  const frame: Record<string, number> = {};
  for (const key of ['prompt_tokens', 'completion_tokens']) {
    const raw = usage[key];
    let value: number | null = null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      value = Math.trunc(raw);
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed)) value = Math.trunc(parsed);
    }
    if (value !== null && value > 0) frame[key] = value;
  }
  return frame;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/**
 * 用量闭环包装：LLM usage 帧 → 节点成本账 + llm_usage 指标事件。
 *
 * 生产用量闭环接线：执行器在节点边界注入当前节点上下文，本包装在每次调用的
 * usage 帧处：ctx.account_usage(usage)（token 计入当前节点执行边界成本账）+
 * ctx.emit("llm_usage", frame)（指标帧进事件流）。用法：引擎/宿主在把 LLM
 * 交给节点消费前包一层（装配即包装）。用量闭环是增强能力：节点上下文缺失/
 * 上报失败只忽略，不阻断 LLM 调用。
 */
export class UsageTrackingLLM implements AsyncLLM {
  readonly adapter = 'usage_tracking';
  readonly config: LLMConfig = _GUARD_CONFIG;
  private readonly _inner: AsyncLLM;

  /** 包装内层模型（AsyncLLM 结构契约，宿主注入）。 */
  constructor(inner: AsyncLLM) {
    this._inner = inner;
  }

  private async _account(usage: Usage): Promise<void> {
    if (usage === null || usage === undefined) return;
    if (typeof usage === 'object' && Object.keys(usage).length === 0) return;
    const ctx = current_node_context.get();
    if (ctx === null) return;
    try {
      const obj = ctx as Record<string, unknown>;
      const account = obj['account_usage'];
      if (typeof account === 'function') {
        account.call(ctx, usage);
      }
      const emit = obj['emit'];
      if (typeof emit === 'function') {
        const frame = _usage_frame(usage);
        if (Object.keys(frame).length > 0) {
          const outcome = emit.call(ctx, 'llm_usage', frame);
          if (isPromiseLike(outcome)) await outcome;
        }
      }
    } catch {
      // Python 侧 logger.warning 留痕；TS core 零 IO/零日志：静默忽略，不阻断调用
    }
  }

  async ainvoke(
    messages: readonly Message[],
    opts: InvokeOptions = {},
  ): Promise<LLMResult> {
    const result = await this._inner.ainvoke(messages, _withNulls(opts));
    await this._account(result.usage);
    return result;
  }

  async *astream(
    messages: readonly Message[],
    opts: InvokeOptions = {},
  ): AsyncGenerator<LLMChunk> {
    for await (const chunk of this._inner.astream(messages, _withNulls(opts))) {
      if (chunk.usage) await this._account(chunk.usage);
      yield chunk;
    }
  }

  async aclose(): Promise<void> {
    await this._inner.aclose();
  }
}

/**
 * 回合内上下文压缩包装：LLM 调用前按 CompressPolicy 压缩消息流。
 *
 * 触发阈值与保留尾段长度可配（policy/keep_recent），默认 ThresholdCompressionPolicy
 * （30 条 / 160000 字符，构造参数可覆盖）——触发前原样透传零改动；触发后旧消息段
 * 折叠为确定性摘要（compress_message_history，非破坏性视图：原始消息流不修改）。
 */
export class CompressingLLM implements AsyncLLM {
  readonly adapter = 'compressing';
  readonly config: LLMConfig = _GUARD_CONFIG;
  private readonly _inner: AsyncLLM;
  private readonly _policy: CompressionPolicy;
  private readonly _keep_recent: number;

  /**
   * 包装内层模型。
   *
   * @param inner 被包装的模型/模型链（AsyncLLM 结构契约）。
   * @param opts.policy 压缩策略（缺省 = 引擎默认 ThresholdCompressionPolicy，
   *   30 条 / 160000 字符）。
   * @param opts.keep_recent 压缩触发时保留的最近消息条数（system 消息恒保留）。
   */
  constructor(
    inner: AsyncLLM,
    opts: { policy?: CompressionPolicy | null; keep_recent?: number } = {},
  ) {
    this._inner = inner;
    this._policy = opts.policy ?? new ThresholdCompressionPolicy();
    this._keep_recent = opts.keep_recent ?? 10;
  }

  /** 压缩视图（未触发 = 原列表副本；确定性、非破坏性）。 */
  _apply(messages: readonly Message[]): Message[] {
    if (messages.length === 0) return [...messages];
    return compress_message_history(messages, {
      policy: this._policy,
      keep_recent: this._keep_recent,
    }) as Message[];
  }

  async ainvoke(
    messages: readonly Message[],
    opts: InvokeOptions = {},
  ): Promise<LLMResult> {
    return this._inner.ainvoke(this._apply(messages), _withNulls(opts));
  }

  async *astream(
    messages: readonly Message[],
    opts: InvokeOptions = {},
  ): AsyncGenerator<LLMChunk> {
    for await (const chunk of this._inner.astream(
      this._apply(messages),
      _withNulls(opts),
    )) {
      yield chunk;
    }
  }

  async aclose(): Promise<void> {
    await this._inner.aclose();
  }
}

/** tools/params 归一为显式 null（镜像 Python 关键字实参缺省 None 透传）。 */
function _withNulls(opts: InvokeOptions): InvokeOptions {
  return { tools: opts.tools ?? null, params: opts.params ?? null };
}
