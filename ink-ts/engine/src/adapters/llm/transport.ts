/**
 * OpenAI 兼容适配器的可注入传输缝（本地类型，零第三方 SDK）。
 *
 * 缝把「HTTP POST + 响应按 SSE 行增量读取」抽象为 LLMTransport，让适配器
 * 与具体 HTTP 栈解耦：测试注入假传输端（mock，零真实网络）；生产默认走
 * 全局 fetch（tsconfig lib=ES2022 + types=node 已含 fetch 全局类型，无需
 * node:https 兜底实现）。
 *
 * 传输异常在出缝前统一归一为 TransportTimeoutError / TransportNetworkError
 * （类名落入 core/llm/errors.ts 的 classify_llm_error 识别集合），适配器
 * 侧只按 LLMError 分类消费。取消语义：调用方 break/关闭 → close() 取消
 * 上游 body，不悬挂连接。
 */

/** 单次 HTTP 请求描述（body 为已序列化 JSON 文本）。 */
export interface TransportRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** 超时毫秒（读流为空闲超时：每个数据块到达间隔超过则中止）。 */
  readonly timeout_ms: number;
}

/** 响应：状态 + 头 + 文本读取（非流式）或按行读取（SSE）。 */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** 完整响应体文本（消费型：与 lines() 互斥使用）。 */
  text(): Promise<string>;
  /** 响应体按行切分（\n 分隔、\r 剥离），消费一次即止。 */
  lines(): AsyncIterable<string>;
  /** 释放底层资源/取消上游 body（幂等）。 */
  close(): Promise<void>;
}

/** 传输缝（本地类型）：适配器只依赖本接口，测试注入假实现。 */
export interface LLMTransport {
  request(req: TransportRequest): Promise<TransportResponse>;
  /** 释放传输持有的长生命周期资源（无则省略）。 */
  close?(): Promise<void>;
}

/**
 * 读超时传输异常：构造器名以字面 Timeout 结尾（对齐 httpx ReadTimeout/
 * ConnectTimeout 的命名族）→ classify_llm_error 按 name.endsWith('Timeout')
 * 归 LLMTimeoutError。导出别名 TimeoutError 便于语义化使用。
 */
export class RequestTimeout extends Error {}

export { RequestTimeout as TimeoutError };

/** 网络传输异常（constructor.name 落入 classify_llm_error 网络集合）。 */
export class NetworkError extends Error {}

/** 归一传输异常：超时中止 → RequestTimeout；其余网络失败 → NetworkError。 */
function translate_error(exc: unknown): Error {
  if (exc instanceof Error && exc.name === 'AbortError') {
    return new RequestTimeout(exc.message || '请求超时或已中止');
  }
  const message = exc instanceof Error ? exc.message : String(exc);
  return new NetworkError(message);
}

/** 默认 fetch 传输（tsconfig 已含全局 fetch 类型：types=node web-globals）。 */
export function create_fetch_transport(): LLMTransport {
  return { request: fetch_request, close: async () => undefined };
}

async function fetch_request(req: TransportRequest): Promise<TransportResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  // 空闲超时：每个 IO 等待（连头部/读块）开始前重新武装计时器。
  const arm = (): void => {
    disarm();
    timer = setTimeout(() => controller.abort(new Error('请求超时或已中止')), req.timeout_ms);
  };
  arm();
  let raw: Response;
  try {
    raw = await fetch(req.url, {
      method: 'POST',
      headers: { accept: 'application/json', ...req.headers },
      body: req.body,
      signal: controller.signal,
    });
  } catch (exc) {
    disarm();
    throw translate_error(exc);
  }
  const headers: Record<string, string> = {};
  raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: raw.status,
    headers,
    text: async () => {
      arm();
      try {
        return await raw.text();
      } catch (exc) {
        throw translate_error(exc);
      } finally {
        disarm();
      }
    },
    lines: () => fetch_lines(raw, arm, disarm),
    close: async () => {
      disarm();
      try {
        await raw.body?.cancel();
      } catch {
        // 取消失败不抛（连接可能已关闭），幂等兜底。
      }
    },
  };
}

async function* fetch_lines(
  raw: Response,
  arm: () => void,
  disarm: () => void,
): AsyncIterable<string> {
  const body = raw.body;
  if (body === null) {
    disarm();
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      arm();
      let chunk: Uint8Array | undefined;
      try {
        const next = await reader.read();
        chunk = next.value;
        if (next.done) break;
      } catch (exc) {
        throw translate_error(exc);
      }
      if (chunk === undefined) continue;
      buffer += decoder.decode(chunk, { stream: true });
      // 完整性边界切行：跨块帧在此拼接（坏帧由解析层容错跳过）。
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        yield line;
        idx = buffer.indexOf('\n');
      }
    }
    if (buffer.length > 0) {
      if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
      yield buffer;
    }
  } finally {
    disarm();
    try {
      reader.releaseLock();
    } catch {
      // 释放锁失败忽略（body 已取消/结束的兜底）。
    }
  }
}
