import { describe, expect, it } from 'vitest';

import { buildHandlers } from '../src/handlers.js';
import {
  ERROR_CODES,
  handleRequest,
  INTERNAL_ERROR_MESSAGE,
  parseLine,
  type RpcRequest,
  type RpcResponse,
} from '../src/rpc.js';

function expectRequest(line: string): RpcRequest {
  const parsed = parseLine(line);
  if ('error' in parsed) throw new Error(`unexpected error branch: ${JSON.stringify(parsed.error)}`);
  return parsed.request;
}

function expectError(line: string): RpcResponse {
  const parsed = parseLine(line);
  if ('request' in parsed) throw new Error(`unexpected request branch: ${JSON.stringify(parsed.request)}`);
  return parsed.error;
}

describe('parseLine 协议校验', () => {
  it('解析合法请求', () => {
    const request = expectRequest('{"jsonrpc":"2.0","id":1,"method":"host.ping"}');
    expect(request.method).toBe('host.ping');
    expect(request.id).toBe(1);
  });

  it('非 JSON 行回 -32700', () => {
    const error = expectError('not json');
    expect(error.error?.code).toBe(ERROR_CODES.parseError);
    expect(error.id).toBeNull();
  });

  it('JSON 字面量/数组均不崩且回 -32600', () => {
    for (const line of ['null', '"str"', '42', 'true', '[1]']) {
      const error = expectError(line);
      expect(error.error?.code).toBe(ERROR_CODES.invalidRequest);
      expect(error.id).toBeNull();
    }
  });

  it('jsonrpc 非 2.0 回 -32600', () => {
    const error = expectError('{"jsonrpc":"1.0","id":1,"method":"host.ping"}');
    expect(error.error?.code).toBe(ERROR_CODES.invalidRequest);
  });

  it('method 缺失或空串回 -32600（可检测 id 原样回显）', () => {
    expect(expectError('{"jsonrpc":"2.0","id":7}').error?.code).toBe(ERROR_CODES.invalidRequest);
    expect(expectError('{"jsonrpc":"2.0","id":7}').id).toBe(7);
    expect(expectError('{"jsonrpc":"2.0","id":8,"method":""}').error?.code).toBe(ERROR_CODES.invalidRequest);
    expect(expectError('{"jsonrpc":"2.0","id":9,"method":42}').error?.code).toBe(ERROR_CODES.invalidRequest);
  });

  it('id 类型非法（对象/布尔）回 -32600 且错误 id 置 null', () => {
    const badObject = expectError('{"jsonrpc":"2.0","id":{},"method":"x"}');
    expect(badObject.error?.code).toBe(ERROR_CODES.invalidRequest);
    expect(badObject.id).toBeNull();
    const badBool = expectError('{"jsonrpc":"2.0","id":true,"method":"x"}');
    expect(badBool.error?.code).toBe(ERROR_CODES.invalidRequest);
    expect(badBool.id).toBeNull();
  });
});

describe('parseLine notification / id:null 判别', () => {
  it('无 id 的合法请求保留为 notification（不折叠成 id:null）', () => {
    const request = expectRequest('{"jsonrpc":"2.0","method":"host.ping"}');
    expect(request.id).toBeUndefined();
    expect('id' in request).toBe(false);
  });

  it('显式 id:null 与无 id 可区分', () => {
    const request = expectRequest('{"jsonrpc":"2.0","id":null,"method":"host.ping"}');
    expect('id' in request).toBe(true);
    expect(request.id).toBeNull();
  });

  it('数字 id 0 合法保留', () => {
    expect(expectRequest('{"jsonrpc":"2.0","id":0,"method":"host.ping"}').id).toBe(0);
  });
});

describe('handleRequest', () => {
  it('未知方法回 -32601 且 id 原样回显', async () => {
    const response = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'nope' }, buildHandlers(), {
      autoApprove: false,
    });
    expect(response.error?.code).toBe(ERROR_CODES.methodNotFound);
    expect(response.id).toBe(2);
  });

  it('handler 抛错：响应只回通用文案，细节进注入式 diag', async () => {
    const diag: unknown[] = [];
    const handlers = new Map([['boom', () => Promise.reject(new Error('secret boom detail'))]]);
    const response = await handleRequest(
      { jsonrpc: '2.0', id: 9, method: 'boom' },
      handlers,
      { autoApprove: false },
      (event) => diag.push(event),
    );
    expect(response.error?.code).toBe(ERROR_CODES.internalError);
    expect(response.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(response.error?.message).not.toContain('secret');
    expect(diag).toHaveLength(1);
    const event = diag[0] as { kind: string; id: number; method: string; error: Error };
    expect(event.kind).toBe('handler-error');
    expect(event.id).toBe(9);
    expect(event.method).toBe('boom');
    expect(event.error.message).toContain('secret');
  });

  it('handler 同步抛出同样走通用文案兜底', async () => {
    const response = await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'sync' },
      new Map([
        [
          'sync',
          () => {
            throw new Error('inner');
          },
        ],
      ]),
      { autoApprove: false },
    );
    expect(response.error?.code).toBe(ERROR_CODES.internalError);
    expect(response.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it('host.ping 返回 pong', async () => {
    const response = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'host.ping' }, buildHandlers(), {
      autoApprove: false,
    });
    expect(response.result).toBe('pong');
  });

  it('host.info 声明审批姿态（autoApprove 来自显式声明）', async () => {
    const explicit = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'host.info' }, buildHandlers(), {
      autoApprove: true,
    });
    const info = explicit.result as { autoApprove: boolean; approvals: string };
    expect(info.autoApprove).toBe(true);
    expect(info.approvals).toBe('explicit-only');
  });
});
