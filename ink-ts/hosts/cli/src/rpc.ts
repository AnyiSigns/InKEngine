/**
 * stdio JSON-RPC 2.0 协议的请求/响应形态、协议校验与单条消息处理（纯函数，
 * 便于单测）。宿主方法集合由 handlers 注入；未知方法回 -32601。
 * 响应不透传内部异常细节：handler 错误只回通用 message，细节交给注入式
 * diag 通道（见 ./diag.ts），本模块不直接做任何 IO。
 */

import type { DiagSink } from './diag.js';

export interface RpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  /** 缺省该成员即 notification（JSON-RPC「无 id 成员」= 不回包）。 */
  id?: number | string | null;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** JSON-RPC 2.0 协议错误码（§5.1）单一来源，禁止在仓内散落字面量。 */
export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internalError: -32603,
} as const;

export const INTERNAL_ERROR_MESSAGE = 'internal error';

export type ParseResult = { request: RpcRequest } | { error: RpcResponse };

function isValidId(value: unknown): value is number | string | null {
  return value === null || typeof value === 'number' || typeof value === 'string';
}

export function invalidRequestError(id: number | string | null): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code: ERROR_CODES.invalidRequest, message: 'invalid request' } };
}

export function internalErrorResponse(id: number | string | null): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code: ERROR_CODES.internalError, message: INTERNAL_ERROR_MESSAGE } };
}

export function parseLine(line: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: { jsonrpc: '2.0', id: null, error: { code: ERROR_CODES.parseError, message: 'parse error' } } };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    // null/字符串/数字/布尔等非对象 JSON：结构上不可能是合法请求，回 -32600
    return { error: invalidRequestError(null) };
  }
  const raw = parsed as { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };
  const hasId = 'id' in raw;
  if (hasId && !isValidId(raw.id)) {
    return { error: invalidRequestError(null) };
  }
  const id = hasId ? (raw.id as number | string | null) : null;
  if (raw.jsonrpc !== '2.0' || typeof raw.method !== 'string' || raw.method === '') {
    return { error: invalidRequestError(id) };
  }
  const request: RpcRequest = { jsonrpc: '2.0', method: raw.method, params: raw.params };
  if (hasId) request.id = raw.id as number | string | null;
  return { request };
}

export type Handler = (params: unknown, ctx: HandlerContext) => Promise<unknown> | unknown;

export interface HandlerContext {
  autoApprove: boolean;
  /** serve 每请求注入的取消信号；handler 可选协作（忽略则执行至完成）。 */
  signal?: AbortSignal;
}

export function handleRequest(
  req: RpcRequest,
  handlers: ReadonlyMap<string, Handler>,
  ctx: HandlerContext,
  diag?: DiagSink,
): Promise<RpcResponse> {
  const handler = handlers.get(req.method);
  if (!handler) {
    return Promise.resolve({
      jsonrpc: '2.0',
      id: req.id ?? null,
      error: { code: ERROR_CODES.methodNotFound, message: 'method not found' },
    });
  }
  return Promise.resolve()
    .then(() => handler(req.params, ctx))
    .then(
      (result) => ({ jsonrpc: '2.0' as const, id: req.id ?? null, result }),
      (error: unknown) => {
        diag?.({ kind: 'handler-error', id: req.id ?? null, method: req.method, error });
        return internalErrorResponse(req.id ?? null);
      },
    );
}
