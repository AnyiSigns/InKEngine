/**
 * MCP Streamable HTTP 传输的 IO 原语（http_transport.ts 拆分出）：空闲
 * 中止控制器 + 响应体带字节上界的流式读取 + SSE data 事件切分。
 *
 * 空闲中止：请求全程（POST 头部等待 / 读体逐块）共用同一 AbortController，
 * 每次 IO 等待前重新武装计时，超时中止仍在途 fetch（镜像 llm fetch_transport
 * 语义）。响应体读取带字节上界：边读边计数、超限即取消上游（不整读后
 * 才发现——恶意超大 JSON/SSE 体不得无限缓冲），与 stdio 帧上限同常量。
 */

/** fetch 响应体读侧的最小形态（body 缺失 = 整读回落，测试桩常见）。 */
export interface BodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

/** 空闲中止控制器：arm 后经 timeout_ms 中止；disarm 解除。 */
export interface IdleAbort {
  readonly controller: AbortController;
  arm(): void;
  disarm(): void;
  timed_out(): boolean;
}

/** 建空闲中止控制器（绑定 AbortController；超时中止仍在途 IO）。 */
export function make_idle_abort(timeout_ms: number): IdleAbort {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timed_out = false;
  return {
    controller,
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

/**
 * 响应体 → 文本（带字节上界）：有流式 body 时逐块读、边读边计数，超限
 * 立即 cancel 上游并抛 overflow（不整读后再检查）；无 body（测试桩/宿主
 * 自实现 seam）回落整读后校验。读阶段逐块重新武装 idle（空等不悬挂）。
 */
export async function read_body_bounded(
  body: BodyReaderLike | null,
  text: () => Promise<string>,
  limit: number,
  overflow: () => never,
  idle: IdleAbort | null = null,
): Promise<string> {
  if (body === null) {
    const whole = await text();
    if (Buffer.byteLength(whole, 'utf8') > limit) overflow();
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      if (idle !== null) idle.arm();
      let chunk: Uint8Array | undefined;
      try {
        const next = await body.read();
        chunk = next.value;
        if (next.done) break;
      } finally {
        if (idle !== null) idle.disarm();
      }
      if (chunk === undefined) continue;
      total += chunk.length;
      if (total > limit) {
        over = true;
        break;
      }
      chunks.push(chunk);
    }
  } finally {
    if (over) {
      try {
        await body.cancel();
      } catch {
        /* 已关闭/取消 忽略 */
      }
    }
  }
  if (over) overflow();
  return Buffer.concat(chunks).toString('utf-8');
}

/** SSE data 事件解析（流式/整读响应共享；data 行拼接事件，坏行跳过）。 */
export function parse_sse_events(text: string): string[] {
  const events: string[] = [];
  let data: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      if (data.length > 0) {
        events.push(data.join('\n'));
        data = [];
      }
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length > 0) events.push(data.join('\n'));
  return events;
}
