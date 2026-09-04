/**
 * Anthropic 适配器传输 seam（httpx AsyncClient/ MockTransport 的镜像）。
 *
 * 与 openai 适配器共用同一 seam 形态（post/headers/json/timeout_ms +
 * status/json()/body_text()/aiter_lines()），本模块独立自承载以免受并发
 * 迁移对共享 _transport.ts 的编辑影响；若后续收敛可直接切换 import 路径。
 *
 * 生产缺省基于全局 fetch（Node ≥18 / Deno / Bun 内建），零厂商 SDK、零
 * 第三方 HTTP 客户端；连接池由运行时管理，无显式关闭资源。测试注入 fake
 * transport（捕获请求并回放响应）即可零真实网络驱动。
 *
 * 传输异常归一：fetch 超时（AbortError）映射 TimeoutError、其余网络失败
 * 映射 NetworkError——与 core/llm/errors.ts classify_llm_error(exc=) 按
 * Error.name 分类的命名对齐，确保瞬时故障可被重试/备用策略识别。响应体
 * 只允许消费一次（与 httpx 语义一致）。
 */

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

// fetch 结构级最小类型（lib 无 DOM，Node 全局 fetch 属运行时能力；结构适配
// 真实 Response 的超集形态，运行时无需任何第三方）。
interface FetchReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

interface FetchResponseLike {
  readonly status: number;
  text(): Promise<string>;
  readonly body: { getReader(): FetchReaderLike } | null;
}

interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: { aborted: boolean };
}

type FetchLike = (input: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

/** 取回运行时的全局 fetch（缺失返回 null，由默认传输调用时显式报错）。 */
export function global_fetch_impl(): FetchLike | null {
  const impl = (globalThis as { fetch?: unknown }).fetch;
  return typeof impl === 'function' ? (impl as FetchLike) : null;
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

/** fetch Response → LlmResponse（body 只允许消费一次，与 httpx 语义一致）。 */
class FetchLlmResponse implements LlmResponse {
  readonly status: number;
  private readonly _res: FetchResponseLike;
  private _text_promise: Promise<string> | null = null;

  constructor(res: FetchResponseLike) {
    this.status = res.status;
    this._res = res;
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
    return _stream_lines(this._res.body);
  }

  /** 响应体一次性读入并缓存（错误详情 / json 路径不会二次消费）。 */
  private _text(): Promise<string> {
    if (this._text_promise === null) {
      this._text_promise = this._res.text();
    }
    return this._text_promise;
  }
}

/** 响应体字节流 → 文本行（跨 chunk 合并半行/多字节字符；含空行，SSE 宽容）。 */
async function* _stream_lines(body: { getReader(): FetchReaderLike } | null): AsyncIterable<string> {
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value ?? new Uint8Array(0), { stream: true });
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
    // 消费方提前中断（取消/返回）时关闭上游连接（镜像 Python 退出路径显式关流）
    try {
      await reader.cancel();
    } catch {
      /* 已关闭/取消 忽略 */
    }
  }
}

/** 生产默认传输：全局 fetch + AbortController 超时（可注入 fetch 实现）。 */
export function fetch_transport(fetch_impl: FetchLike | null = null): LlmTransport {
  return {
    async post(url: string, request: LlmPostRequest): Promise<LlmResponse> {
      const impl = fetch_impl ?? global_fetch_impl();
      if (impl === null) {
        throw new Error(
          'LLM 适配器缺省传输需要全局 fetch（Node ≥18）或宿主注入 transport/fetch 实现',
        );
      }
      const controller = new AbortController();
      let timed_out = false;
      const timer = setTimeout(() => {
        timed_out = true;
        controller.abort();
      }, request.timeout_ms);
      let res: FetchResponseLike;
      try {
        res = await impl(url, {
          method: 'POST',
          headers: { ...request.headers },
          body: JSON.stringify(request.json),
          signal: controller.signal,
        });
      } catch (exc) {
        throw _normalize_fetch_error(exc, timed_out);
      } finally {
        clearTimeout(timer);
      }
      return new FetchLlmResponse(res);
    },
  };
}
