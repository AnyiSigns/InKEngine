/**
 * stdio JSON-RPC 服务：逐行读输入、受限并发处理，响应只写 stdout、诊断只写
 * stderr（默认）；流与诊断可注入便于单测。默认值即最小健壮基线：行上限
 * 1MiB、并发上限 64、单请求超时 60s、close 后排空在飞请求再退出。
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { jsonDiag, type DiagSink } from './diag.js';
import {
  handleRequest,
  internalErrorResponse,
  invalidRequestError,
  parseLine,
  type Handler,
  type HandlerContext,
  type RpcRequest,
  type RpcResponse,
} from './rpc.js';

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT = 64;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface ServeOptions {
  autoApprove: boolean;
  handlers: ReadonlyMap<string, Handler>;
  input?: Readable;
  output?: Writable;
  diagStream?: Writable;
  maxLineBytes?: number;
  maxConcurrent?: number;
  requestTimeoutMs?: number;
}

function writeJson(output: Writable, response: RpcResponse): void {
  try {
    output.write(`${JSON.stringify(response)}\n`);
  } catch {
    // 输出通道损坏时已无法回包，静默（进程退出由入口负责）
  }
}

/** 单请求执行：AbortSignal 超时中止；超时/异常均只回通用 -32603，细节进 diag。 */
function settleRequest(
  request: RpcRequest,
  handlers: ReadonlyMap<string, Handler>,
  baseCtx: { autoApprove: boolean },
  timeoutMs: number,
  diag: DiagSink,
): Promise<RpcResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const ctx: HandlerContext = { autoApprove: baseCtx.autoApprove, signal: controller.signal };
  return new Promise<RpcResponse>((resolve) => {
    handleRequest(request, handlers, ctx, diag).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      () => {
        // 保险：handleRequest 自身不 reject，此分支仅内部缺陷时触发
        clearTimeout(timer);
        resolve(internalErrorResponse(request.id ?? null));
      },
    );
    controller.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        diag({ kind: 'request-timeout', id: request.id ?? null, method: request.method });
        resolve(internalErrorResponse(request.id ?? null));
      },
      { once: true },
    );
  });
}

export async function serve(options: ServeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const handlers = options.handlers;
  const autoApprove = options.autoApprove;
  const diag: DiagSink = jsonDiag(options.diagStream ?? process.stderr);

  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending: string[] = [];
  const active = new Set<Promise<void>>();
  let running = 0;
  let inputPaused = false;
  let closed = false;

  const pauseInput = (): void => {
    if (!inputPaused) {
      inputPaused = true;
      rl.pause();
    }
  };
  const resumeInput = (): void => {
    if (inputPaused && !closed && running < maxConcurrent) {
      inputPaused = false;
      rl.resume();
    }
  };

  async function processLine(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const bytes = Buffer.byteLength(trimmed, 'utf8');
    if (bytes > maxLineBytes) {
      diag({ kind: 'line-too-long', length: bytes, limit: maxLineBytes });
      writeJson(output, invalidRequestError(null));
      return;
    }
    const parsed = parseLine(trimmed);
    if ('error' in parsed) {
      writeJson(output, parsed.error);
      return;
    }
    const request = parsed.request;
    const response = await settleRequest(request, handlers, { autoApprove }, requestTimeoutMs, diag);
    if (request.id !== undefined) writeJson(output, response);
  }

  function dispatch(): void {
    while (pending.length > 0 && running < maxConcurrent) {
      const raw = pending.shift() as string;
      running += 1;
      const tracked = Promise.resolve(processLine(raw))
        .catch((error: unknown) => {
          // 兜底：processLine 内部已闭环，此分支仅内部缺陷时触发，杜绝 unhandled
          diag({ kind: 'handler-error', id: null, method: '<unknown>', error });
        })
        .finally(() => {
          running -= 1;
          active.delete(tracked);
          dispatch();
          resumeInput();
        });
      active.add(tracked);
    }
  }

  rl.on('line', (raw: string) => {
    pending.push(raw);
    dispatch();
    if (running >= maxConcurrent) pauseInput();
  });

  await new Promise<void>((resolveClose) => {
    rl.once('close', resolveClose);
    rl.once('error', resolveClose);
  });
  closed = true;
  // close 后排空：在飞请求与排队行全部处理完再退出（每个请求有超时上界，不会悬挂）
  while (active.size > 0) {
    await Promise.allSettled([...active]);
  }
}
