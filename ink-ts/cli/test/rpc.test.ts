import { describe, expect, it } from 'vitest';

import { buildHandlers } from '../src/handlers.js';
import { handleRequest, parseLine } from '../src/rpc.js';

describe('stdio JSON-RPC', () => {
  it('解析合法请求', () => {
    const { request, error } = parseLine('{"jsonrpc":"2.0","id":1,"method":"host.ping"}');
    expect(error).toBeUndefined();
    expect(request?.method).toBe('host.ping');
  });

  it('解析非法行回 -32700', () => {
    const { request, error } = parseLine('not json');
    expect(request).toBeUndefined();
    expect(error?.error?.code).toBe(-32700);
  });

  it('未知方法回 -32601', async () => {
    const handlers = buildHandlers();
    const response = await handleRequest(
      { jsonrpc: '2.0', id: 2, method: 'nope' },
      handlers,
      { autoApprove: false },
    );
    expect(response.error?.code).toBe(-32601);
  });

  it('host.ping 返回 pong', async () => {
    const handlers = buildHandlers();
    const response = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'host.ping' }, handlers, {
      autoApprove: false,
    });
    expect(response.result).toBe('pong');
  });

  it('host.info 声明审批姿态（autoApprove 来自显式声明）', async () => {
    const handlers = buildHandlers();
    const explicit = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'host.info' }, handlers, {
      autoApprove: true,
    });
    const info = explicit.result as { autoApprove: boolean; approvals: string };
    expect(info.autoApprove).toBe(true);
    expect(info.approvals).toBe('explicit-only');
  });

  it('handler 抛错回 -32603', async () => {
    const handlers = new Map([['boom', () => Promise.reject(new Error('boom'))]]);
    const response = await handleRequest({ jsonrpc: '2.0', id: 9, method: 'boom' }, handlers, {
      autoApprove: false,
    });
    expect(response.error?.code).toBe(-32603);
  });
});
