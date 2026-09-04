/**
 * stdio JSON-RPC 2.0 协议的请求/响应形态与单条消息处理（纯函数，便于单测）。
 * 宿主方法集合由 handlers 注入；未知方法回 -32601。
 */

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export function parseLine(line: string): { request?: RpcRequest; error?: RpcResponse } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } } };
  }
  const req = parsed as Partial<RpcRequest>;
  if (typeof req.method !== 'string' || req.jsonrpc !== '2.0') {
    return { error: { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32600, message: 'invalid request' } } };
  }
  return {
    request: {
      jsonrpc: '2.0',
      id: req.id ?? null,
      method: req.method,
      params: req.params,
    },
  };
}

export type Handler = (params: unknown, ctx: HandlerContext) => Promise<unknown> | unknown;

export interface HandlerContext {
  autoApprove: boolean;
}

export function handleRequest(req: RpcRequest, handlers: ReadonlyMap<string, Handler>, ctx: HandlerContext): Promise<RpcResponse> {
  const handler = handlers.get(req.method);
  if (!handler) {
    return Promise.resolve({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  }
  return Promise.resolve()
    .then(() => handler(req.params, ctx))
    .then(
      (result) => ({ jsonrpc: '2.0', id: req.id, result }),
      (err: unknown) => ({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      }),
    );
}
