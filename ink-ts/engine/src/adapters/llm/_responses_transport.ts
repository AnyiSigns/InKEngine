/**
 * OpenAI Responses 适配器传输 seam（openai_response.py 的 httpx transport
 * 注入等价物；Responses 专用拆分，避免与 openai_compat/anthropic 侧正在
 * 演化的共享 transport 模块互相踩踏）。
 *
 * 形态对齐 httpx.MockTransport：测试注入 fake transport（捕获请求并回放
 * 响应）即可零真实网络驱动适配器；生产默认实现基于全局 fetch（Node 18+ /
 * Deno / Bun 内建，@types/node web-globals 自带类型），零厂商 SDK、零第三方
 * HTTP 客户端。连接池由运行时管理，无显式关闭资源，故 aclose 为空实现。
 *
 * 传输异常归一：fetch 超时（AbortError）映射 TimeoutError、其余网络失败
 * 映射 NetworkError——与 core/llm/errors.ts 的 classify_llm_error(exc=)
 * 按 Error.name 分类的命名对齐，确保瞬时故障可被重试策略识别。
 */

import { TextDecoder } from 'node:util';

/** HTTP 响应抽象（fake / fetch 实现共用；流式响应经 aiter_lines 逐行读）。 */
export interface LlmResponse {
  readonly status: number;
  json(): Promise<unknown>;
  body_text(): Promise<string>;
  aiter_lines(): AsyncIterable<string>;
}

/** POST 请求载荷（json 为已结构化的请求体；headers 全字符串键值）。 */
export interface LlmPostRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
  readonly timeout_ms: number;
}

/** 传输 seam：post 一次即返回响应（非流式 json / 流式 aiter_lines）。 */
export interface LlmTransport {
  post(url: string, request: LlmPostRequest): Promise<LlmResponse>;
}

/** 把 fetch 拒绝归一为已知 Error.name（classify_llm_error 的 exc 分支识别）。 */
function _normalize_fetch_error(exc: unknown, timed_out: boolean): Error {
  if (exc instanceof Error && exc.name === 'AbortError' && timed_out) {
    const timeout = new Error('LLM 请求超时');
    timeout.name = 'TimeoutError';
    return timeout;
  }
  const msg = exc instanceof Error ? exc.message : String(exc);
  const network = new Error(msg || '网络请求失败');
  network.name = 'NetworkError';
  return network;
}

/** 逐读空闲超时控制（镜像 transport.ts 语义：每次 IO 等待前重新武装）。 */
interface ReadIdleTimer {
  arm(): void;
  disarm(): void;
  /** 当前计时是否已因超时中止（AbortError 归 TimeoutError 的依据）。 */
  timed_out(): boolean;
}

/** 建逐读空闲计时器：绑定 AbortController，超时中止仍在途 IO。 */
function make_idle_timer(
  controller: AbortController,
  timeout_ms: number,
): ReadIdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timed_out = false;
  return {
    arm() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timed_out = true;
        controller.abort();
      }, timeout_ms);
    },
    disarm() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    timed_out: () => timed_out,
  };
}

/** fetch Response → LlmResponse（body 只允许消费一次，与 httpx 语义一致；
 *  读阶段（text/流式逐行）经注入的逐读空闲计时器防挂死）。 */
class FetchLlmResponse implements LlmResponse {
  readonly status: number;
  private readonly _res: Response;
  private readonly _idle: ReadIdleTimer;
  private _text_promise: Promise<string> | null = null;

  constructor(res: Response, idle: ReadIdleTimer) {
    this.status = res.status;
    this._res = res;
    this._idle = idle;
  }

  async json(): Promise<unknown> {
    // 统一经 text 消费后 JSON.parse：空 body/坏 JSON 抛 SyntaxError，
    // 由适配器收敛为 LLMFormatError（镜像 Python response.json() 路径）。
    const text = await this._text();
    return JSON.parse(text);
  }

  async body_text(): Promise<string> {
    return this._text();
  }

  aiter_lines(): AsyncIterable<string> {
    return _stream_lines(this._res.body, this._idle);
  }

  /** 响应体一次性读入并缓存（错误详情 / json 路径不会二次消费）。 */
  private _text(): Promise<string> {
    if (this._text_promise === null) {
      this._text_promise = this._read_text();
    }
    return this._text_promise;
  }

  private async _read_text(): Promise<string> {
    this._idle.arm();
    try {
      return await this._res.text();
    } catch (exc) {
      throw _normalize_fetch_error(exc, this._idle.timed_out());
    } finally {
      this._idle.disarm();
    }
  }
}

/** 响应体字节流 → 文本行（跨 chunk 合并半行/多字节字符；含空行，SSE 宽容）。
 *  每读前重新武装空闲超时：块间停顿超过 timeout_ms 即中止（fail-closed）。 */
async function* _stream_lines(
  body: ReadableStream<Uint8Array> | null,
  idle: ReadIdleTimer,
): AsyncIterable<string> {
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      idle.arm();
      let chunk: Uint8Array | undefined;
      try {
        const next = await reader.read();
        chunk = next.value;
        if (next.done) break;
      } catch (exc) {
        throw _normalize_fetch_error(exc, idle.timed_out());
      }
      if (chunk === undefined) continue;
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } finally {
    idle.disarm();
    // 消费方提前中断（取消/返回）时关闭上游连接（镜像 Python 退出路径显式关流）
    try {
      await reader.cancel();
    } catch {
      /* 已关闭/取消 忽略 */
    }
  }
}

/** 生产默认传输：全局 fetch + AbortController 空闲超时（fetch 无流式取消回调）。
 *  头部到达前的连接超时与读阶段逐块空闲超时共用同一计时（每读重新武装）。 */
export function fetch_transport(): LlmTransport {
  return {
    async post(url: string, request: LlmPostRequest): Promise<LlmResponse> {
      const controller = new AbortController();
      const idle = make_idle_timer(controller, request.timeout_ms);
      idle.arm();
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { ...request.headers },
          body: JSON.stringify(request.json),
          signal: controller.signal,
        });
      } catch (exc) {
        idle.disarm();
        throw _normalize_fetch_error(exc, idle.timed_out());
      }
      // 头部已到达：连接阶段计时解除，读阶段（text/流式行）逐读重新武装
      idle.disarm();
      return new FetchLlmResponse(res, idle);
    },
  };
}
