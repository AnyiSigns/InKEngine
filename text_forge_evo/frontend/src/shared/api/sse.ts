// 共享 SSE 读取器：封装 reader/decoder/buffer + JSON 解析循环，避免各流式接口重复实现。
// 调用方在 onEvent 中自行按 event.type 分发业务逻辑。

export type SSEEventHandler = (event: Record<string, unknown>) => void;

/** P-E：60s 无数据 watchdog——MaaS/网关挂起时主动中断，避免前端永久等待。 */
const SSE_IDLE_TIMEOUT_MS = 60_000;

export async function readSSE(
  response: Response,
  onEvent: SSEEventHandler,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        // P-E：每次 read 都带超时保护（无数据 60s 视为连接挂起）
        ({ done, value } = await withTimeout(
          reader.read(),
          SSE_IDLE_TIMEOUT_MS,
          new Error('连接超时：60 秒内未收到服务端数据，请重试'),
        ));
      } catch (err) {
        // 审查修复：超时后主动 cancel 底层流，释放 pending read 与连接
        // （仅抛错会让 reader 锁滞留到服务端超时，资源悬挂）
        if ((err as Error)?.name === 'SSEIdleTimeout') {
          await reader.cancel().catch(() => {});
        }
        throw err;
      }
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue; // skip malformed JSON
        }
        onEvent(event);
      }
    }
  } finally {
    // 流被取消（abort）或已自然结束时，reader 的锁可能已被自动释放，
    // 此时再 releaseLock 会抛 InvalidStateError，需保护避免未处理异常。
    try {
      reader.releaseLock();
    } catch {
      // 忽略：锁已释放
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          error.name = 'SSEIdleTimeout';
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
