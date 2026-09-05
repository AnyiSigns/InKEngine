/**
 * buildHandlers 单测：host.ping/host.info 保留 + host bridge 注入并入命令面。
 *
 * bridge 注入 = 委托 createHost 装配产物（handlers 本身不装配；装配在
 * host.ts assembleCliHost）。信封错误只回通用、细节进 diag（rpc 层语义，
 * 此处断言错误不外泄内部消息）。
 */

import { describe, expect, it } from 'vitest';

import { buildHandlers } from '../src/handlers.js';
import { ERROR_CODES, INTERNAL_ERROR_MESSAGE, handleRequest } from '../src/rpc.js';

function fakeBridge(): Map<string, (params: unknown) => unknown> {
  const entries: Array<[string, (params: unknown) => unknown]> = [
    [
      'rounds.send',
      async (params: unknown) => ({
        thread_id: 't-1',
        reply: `echo:${String((params as { input: string }).input)}`,
      }),
    ],
    ['audit.export', () => [{ type: 'audit_entry', ts: 1 }]],
  ];
  return new Map(entries);
}

describe('buildHandlers 命令面注入', () => {
  it('host.ping / host.info 保留（无 bridge 亦可用）', async () => {
    const handlers = buildHandlers();
    const ping = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'host.ping' }, handlers, { autoApprove: false });
    expect(ping.result).toBe('pong');
    const info = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'host.info' }, handlers, { autoApprove: true });
    expect(info.result).toMatchObject({ name: 'ink-ts-cli', protocol: 'json-rpc-2.0', approvals: 'explicit-only', autoApprove: true });
  });

  it('bridge 方法并入命令面且可调用', async () => {
    const handlers = buildHandlers({ bridge: fakeBridge() });
    const round = await handleRequest(
      { jsonrpc: '2.0', id: 3, method: 'rounds.send', params: { input: 'hi' } },
      handlers,
      { autoApprove: false },
    );
    expect(round.result).toEqual({ thread_id: 't-1', reply: 'echo:hi' });
    const audit = await handleRequest({ jsonrpc: '2.0', id: 4, method: 'audit.export' }, handlers, { autoApprove: false });
    expect((audit.result as unknown[]).length).toBeGreaterThan(0);
  });

  it('bridge handler 抛错只回通用、细节进 diag（rpc 信封约定）', async () => {
    const entries: Array<[string, (params: unknown) => unknown]> = [
      [
        'approval.resolve',
        () => {
          throw new Error('内部决议细节不该出信封');
        },
      ],
    ];
    const bridge = new Map(entries);
    const diag: unknown[] = [];
    const handlers = buildHandlers({ bridge });
    const response = await handleRequest(
      { jsonrpc: '2.0', id: 5, method: 'approval.resolve' },
      handlers,
      { autoApprove: false },
      (event) => diag.push(event),
    );
    expect(response.error?.code).toBe(ERROR_CODES.internalError);
    expect(response.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(diag.length).toBeGreaterThan(0);
  });

  it('未知方法仍回 -32601（bridge 之外的命名空间不受影响）', async () => {
    const handlers = buildHandlers({ bridge: fakeBridge() });
    const response = await handleRequest({ jsonrpc: '2.0', id: 6, method: 'nope' }, handlers, { autoApprove: false });
    expect(response.error?.code).toBe(ERROR_CODES.methodNotFound);
  });
});
