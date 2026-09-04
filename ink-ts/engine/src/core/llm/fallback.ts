/**
 * 挡位级模型链：主模型 + 备用列表 + 指数退避重试 + 流式中断语义
 * （Python core/llm/fallback.py 移植，__all__ = [ModelChain, RetryPolicy] 1:1）。
 *
 * 吸收 text_forge_backend/core/llm_retry 语义（引擎自包含，宿主不再重复实现）：
 *
 * - **重试（指数退避）**：仅瞬时故障（超时/限流/网络/5xx/空流）重试，
 *   确定性失败（认证/请求非法/模型不存在）直接上抛；流式仅「首块前」
 *   重试——已产出内容后的中断重试会破坏流式语义（重复内容）；
 * - **重试唯一权威**：适配器（openai_compat 等）默认单次尝试（其内部重试
 *   已默认关闭，独立直用时按需经构造参数注入），本层的 :class:`RetryPolicy`
 *   是瞬时故障重试的单一配置点——不出现「适配器 3× + 链 3× = 9 请求」叠加；
 * - **备用切换（fallback 链）**：当前模型重试耗尽后仍失败 → 切下一个配置并
 *   重新带完整重试预算（首次块前失败的流式调用同样切换）；已产出内容后失败
 *   不切换（防重复内容），直接上抛；链全部失败抛最后一次错误；
 *   **认证失败（401/403，fail-closed）不切备用**——主模型密钥失效/吊销时
 *   立即上抛，防同一份数据被静默转发到其它端点、防凭据事件被掩盖（其余
 *   确定性失败如模型不存在仍切备用——配置兜底）；
 * - **取消语义**：Python 侧 CancelledError 属 BaseException 不被捕获、原样
 *   穿透；TS 侧无运行时注入的取消异常，仅捕获 LLMError 子类——任何非 LLMError
 *   中断（宿主取消/注入 sleeper 抛错）一律原样穿透，不重试不切备用。
 *
 * TS seam 差异（界面表达，语义对齐以 Python 实际行为为准）：
 * - core 零 IO：logger.warning/error 留痕不落（可观测性在宿主侧落文件）；
 * - **确定性时间缝**：退避睡眠经注入的 `sleep(seconds)` 执行（缺省 setTimeout），
 *   测试注入录制/可控 sleeper 即可零真实等待并确定性中断退避（类比 Python
 *   侧 asyncio.sleep 在取消点的可打断性）；
 * - create 为**结构性工厂注入**（config => AsyncLLM，真实适配器由宿主/适配器
 *   层按配置装配），core 零依赖不内置适配器注册表——未注入时首次需建模型即
 *   抛 LLMConfigError 快速失败。
 */
import { LLMConfigError, LLMAuthError, LLMError, is_transient_llm_error } from './errors.js';
import { AsyncLLM, LLMChunk, LLMConfig, LLMParams, LLMResult } from './base.js';
import type { Message } from './messages.js';
import type { ToolSpec } from './tools.js';

/** 退避睡眠注入面（seconds 与 Python asyncio.sleep 单位一致）。 */
export type Sleeper = (seconds: number) => Promise<void>;

/** 模型实例工厂注入面：config => AsyncLLM（真实适配器结构性装配）。 */
export type CreateLLM = (config: LLMConfig) => AsyncLLM;

/** 缺省退避睡眠：真实计时（宿主运行时）；测试注入确定性 sleeper 覆盖。 */
const _default_sleep: Sleeper = async (seconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
};

/** 缺省模型工厂：core 零依赖不内置注册表，未注入即快速失败（惰性，仅被用时）。 */
function _no_create(): AsyncLLM {
  throw new LLMConfigError(
    'ModelChain 需注入模型工厂 create(config => AsyncLLM)：core 零依赖装配，注册在适配器/宿主层',
  );
}

/** 单模型配置规范化：LLMConfig 直通，字典经 from_dict 收未知键进 extra。 */
function _as_config(cfg: LLMConfig | Record<string, unknown>): LLMConfig {
  return cfg instanceof LLMConfig ? cfg : LLMConfig.from_dict(cfg);
}

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
function _backoff_delay(policy: RetryPolicy, n: number): number {
  return Math.min(policy.base_delay * 2 ** (n - 1), policy.max_delay);
}

/**
 * 主模型 + 备用模型链（挡位级容错：重试 → 备用 → 上抛）。
 *
 * 配置形态：主配置在前，fallback 链为其后的配置列表；层级调用方（挡位装配）
 * 把 main_config + main_fallback_configs 组装为 configs 传入。模型实例惰性构建
 * （链上备用模型只在需要时创建），aclass aclose() 释放已建实例（幂等）。
 */
export class ModelChain {
  private readonly _configs: LLMConfig[];
  private readonly _retry: RetryPolicy;
  private readonly _create: CreateLLM;
  private readonly _sleep: Sleeper;
  private readonly _llms: (AsyncLLM | null)[];

  constructor(
    configs: readonly (LLMConfig | Record<string, unknown>)[],
    opts: { retry?: RetryPolicy | null; create?: CreateLLM | null; sleep?: Sleeper | null } = {},
  ) {
    if (configs.length === 0) {
      throw new LLMConfigError('ModelChain 至少需要一个模型配置');
    }
    this._configs = configs.map(_as_config);
    Object.freeze(this._configs);
    this._retry = opts.retry ?? new RetryPolicy();
    this._create = opts.create ?? _no_create;
    this._sleep = opts.sleep ?? _default_sleep;
    this._llms = new Array<AsyncLLM | null>(this._configs.length).fill(null);
  }

  /** 链上模型配置（只读：装配结果观测/审计，不含运行态实例）。 */
  get configs(): readonly LLMConfig[] {
    return this._configs;
  }

  /** 模型实例惰性构建：链上备用模型只在需要时创建。 */
  private _llm(index: number): AsyncLLM {
    let llm = this._llms[index]!;
    if (llm === null) {
      llm = this._create(this._configs[index]!);
      this._llms[index] = llm;
    }
    return llm;
  }

  /** 释放链上已创建的模型实例（长连接 client 等），幂等。 */
  async aclose(): Promise<void> {
    for (let i = 0; i < this._llms.length; i++) {
      const llm = this._llms[i]!;
      if (llm === null) continue;
      try {
        await llm.aclose();
      } catch {
        // 释放失败不阻断其余实例（logger 留痕 TS core 零 IO 不落）
      }
      this._llms[i] = null;
    }
  }

  // ------------------------------------------------------------------
  // 非流式：重试（瞬时）→ 备用切换 → 上抛
  // ------------------------------------------------------------------
  async ainvoke(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): Promise<LLMResult> {
    const { tools = null, params = null } = opts;
    let last_error: LLMError | null = null;
    for (let i = 0; i < this._configs.length; i++) {
      try {
        return await this._ainvoke_one(i, messages, tools, params);
      } catch (exc) {
        if (exc instanceof LLMAuthError) {
          // fail-closed：认证失败不切备用（密钥失效/吊销立即可见，不静默转发数据）
          throw exc;
        }
        if (!(exc instanceof LLMError)) {
          // 非 LLMError 中断（宿主取消等）原样穿透，不重试不切备用
          throw exc;
        }
        last_error = exc;
        if (i + 1 < this._configs.length) {
          // logger.warning 切换留痕：可观测性副作用 TS core 零 IO 不落
        }
      }
    }
    throw last_error as LLMError;
  }

  private async _ainvoke_one(
    index: number,
    messages: readonly Message[],
    tools: readonly ToolSpec[] | null,
    params: LLMParams | null,
  ): Promise<LLMResult> {
    const attempts = Math.max(1, this._retry.attempts);
    for (let n = 0; n < attempts; n++) {
      try {
        return await this._llm(index).ainvoke(messages, { tools, params });
      } catch (exc) {
        if (!(exc instanceof LLMError) || !is_transient_llm_error(exc) || n === attempts - 1) {
          throw exc;
        }
        await this._sleep(_backoff_delay(this._retry, n + 1));
      }
    }
    throw new LLMError('ModelChain 重试循环意外终止');
  }

  // ------------------------------------------------------------------
  // 流式：单模型首块前重试；首块前失败切备用；产出后失败不切换
  // ------------------------------------------------------------------
  async *astream(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): AsyncGenerator<LLMChunk> {
    const { tools = null, params = null } = opts;
    let last_error: LLMError | null = null;
    for (let i = 0; i < this._configs.length; i++) {
      let got_chunk = false;
      try {
        for await (const chunk of this._astream_one(i, messages, tools, params)) {
          got_chunk = true;
          yield chunk;
        }
        return;
      } catch (exc) {
        if (exc instanceof LLMAuthError) {
          // fail-closed：认证失败不切备用（与 ainvoke 同语义）
          throw exc;
        }
        if (!(exc instanceof LLMError)) {
          // 非 LLMError 中断（宿主取消/流中穿透）原样上抛
          throw exc;
        }
        last_error = exc;
        if (got_chunk) {
          // 已产出内容后失败：切换会产生重复内容，直接上抛
          throw exc;
        }
        if (i + 1 < this._configs.length) {
          // logger.warning 切换留痕：可观测性副作用 TS core 零 IO 不落
        }
      }
    }
    throw last_error as LLMError;
  }

  private async *_astream_one(
    index: number,
    messages: readonly Message[],
    tools: readonly ToolSpec[] | null,
    params: LLMParams | null,
  ): AsyncGenerator<LLMChunk> {
    const attempts = Math.max(1, this._retry.attempts);
    for (let n = 0; n < attempts; n++) {
      let got_chunk = false;
      try {
        for await (const chunk of this._llm(index).astream(messages, { tools, params })) {
          got_chunk = true;
          yield chunk;
        }
        return;
      } catch (exc) {
        if (!(exc instanceof LLMError)) {
          throw exc;
        }
        if (got_chunk || !is_transient_llm_error(exc) || n === attempts - 1) {
          throw exc;
        }
        await this._sleep(_backoff_delay(this._retry, n + 1));
      }
    }
  }
}
