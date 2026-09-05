/**
 * 诊断事件通道：把「不可回给客户端的细节」以 JSON 行写 stderr（可注入其他流）。
 * 纯逻辑层（rpc）只声明事件类型并调用注入的 DiagSink，本模块内的写流实现
 * 属于 IO 侧，供 serve/入口装配。
 */

import type { Writable } from 'node:stream';

export type DiagEvent =
  | { kind: 'handler-error'; id: number | string | null; method: string; error: unknown }
  | { kind: 'request-timeout'; id: number | string | null; method: string }
  | { kind: 'line-too-long'; length: number; limit: number };

export type DiagSink = (event: DiagEvent) => void;

/** 事件序列化为 JSON 行写入指定流；诊断通道故障不影响 RPC 响应通道。 */
export function jsonDiag(stream: Writable): DiagSink {
  return (event) => {
    const record: Record<string, unknown> = { ts: new Date().toISOString(), kind: event.kind };
    if (event.kind === 'line-too-long') {
      record.length = event.length;
      record.limit = event.limit;
    } else {
      record.id = event.id;
      record.method = event.method;
      if (event.kind === 'handler-error') {
        const error = event.error;
        record.error =
          error instanceof Error
            ? { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
            : { message: String(error) };
      }
    }
    try {
      stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // 诊断写失败静默：服务仍须正常回包
    }
  };
}
