import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { buildHandlers } from '../src/handlers.js';
import { ERROR_CODES, INTERNAL_ERROR_MESSAGE, type Handler } from '../src/rpc.js';
import { serve, type ServeOptions } from '../src/server.js';

class Sink extends Writable {
  readonly parts: string[] = [];

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.parts.push(chunk.toString('utf8'));
    callback();
  }

  text(): string {
    return this.parts.join('');
  }

  lines(): string[] {
    return this.text().split('\n').filter((line) => line.length > 0);
  }
}

async function runServe(
  lines: readonly string[],
  overrides: Partial<ServeOptions> = {},
): Promise<{ outLines: string[]; errText: string }> {
  const output = new Sink();
  const diagStream = new Sink();
  const options: ServeOptions = {
    autoApprove: false,
    handlers: buildHandlers(),
    input: Readable.from(lines.map((line) => `${line}\n`)),
    output,
    diagStream,
    maxConcurrent: 8,
    requestTimeoutMs: 2000,
    ...overrides,
  };
  await serve(options);
  return { outLines: output.lines(), errText: diagStream.text() };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('serve stdio JSON-RPC', () => {
  it('对请求回包、对 notification 不回包、id:null 仍回包', async () => {
    const { outLines } = await runServe(
      [
        '{"jsonrpc":"2.0","id":1,"method":"host.ping"}',
        '{"jsonrpc":"2.0","method":"host.ping"}',
        '{"jsonrpc":"2.0","id":null,"method":"host.ping"}',
        '{"jsonrpc":"2.0","id":3,"method":"host.info"}',
      ],
      { maxConcurrent: 1 },
    );
    expect(outLines).toHaveLength(3);
    const replies = outLines.map((line) => JSON.parse(line) as { id: unknown; error?: unknown });
    expect(replies.map((r) => r.id)).toEqual([1, null, 3]);
    expect(replies.every((r) => r.error === undefined)).toBe(true);
  });

  it('handler 抛错不回细节，诊断进 stderr', async () => {
    const handlers = new Map([['boom', () => Promise.reject(new Error('secret boom'))]]);
    const { outLines, errText } = await runServe(['{"jsonrpc":"2.0","id":5,"method":"boom"}'], { handlers });
    expect(outLines).toHaveLength(1);
    const reply = JSON.parse(outLines[0] as string) as { id: number; error?: { message: string } };
    expect(reply.id).toBe(5);
    expect(reply.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(outLines[0]).not.toContain('secret');
    expect(errText).toContain('handler-error');
    expect(errText).toContain('secret boom');
  });

  it('超长行忽略并回 -32600，诊断留痕', async () => {
    const long = `{"jsonrpc":"2.0","id":1,"method":"echo","params":"${'a'.repeat(96)}"}`;
    const { outLines, errText } = await runServe([long], { maxLineBytes: 64 });
    expect(outLines).toHaveLength(1);
    const reply = JSON.parse(outLines[0] as string) as { id: unknown; error?: { code: number } };
    expect(reply.id).toBeNull();
    expect(reply.error?.code).toBe(ERROR_CODES.invalidRequest);
    expect(errText).toContain('line-too-long');
  });

  it('空行忽略；解析失败照常回包', async () => {
    const { outLines } = await runServe(['', 'not json', 'null'], { maxConcurrent: 1 });
    const codes = outLines.map((line) => {
      const reply = JSON.parse(line) as { error?: { code: number } };
      return reply.error?.code;
    });
    expect(codes).toEqual([ERROR_CODES.parseError, ERROR_CODES.invalidRequest]);
  });

  it('超时不悬挂：回 -32603 通用错误并诊断 request-timeout', async () => {
    const handlers = new Map([
      [
        'hang',
        () =>
          new Promise<never>(() => {
            // 永不 resolve，交由服务层超时兜底
          }),
      ],
    ]);
    const { outLines, errText } = await runServe(['{"jsonrpc":"2.0","id":4,"method":"hang"}'], {
      handlers,
      requestTimeoutMs: 50,
    });
    expect(outLines).toHaveLength(1);
    const reply = JSON.parse(outLines[0] as string) as { id: number; error?: { message: string } };
    expect(reply.id).toBe(4);
    expect(reply.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(errText).toContain('request-timeout');
  });

  it('并发不超过上限且全部处理', async () => {
    let active = 0;
    let peak = 0;
    const release = deferred();
    const handlers = new Map<string, Handler>([
      [
        'work',
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          await release.promise;
          active -= 1;
          return 'ok';
        },
      ],
    ]);
    const lines = Array.from({ length: 12 }, (_, i) => `{"jsonrpc":"2.0","id":${i},"method":"work"}`);
    const running = runServe(lines, { handlers, maxConcurrent: 3, requestTimeoutMs: 5000 });
    const releaseTimer = setTimeout(() => release.resolve(), 80);
    const { outLines } = await running;
    clearTimeout(releaseTimer);
    expect(outLines).toHaveLength(12);
    expect(peak).toBe(3);
  });

  it('输入关闭后排空在飞请求与排队行再退出', async () => {
    let active = 0;
    const release = deferred();
    const handlers = new Map<string, Handler>([
      [
        'work',
        async () => {
          active += 1;
          await release.promise;
          active -= 1;
          return 'ok';
        },
      ],
    ]);
    const lines = Array.from({ length: 5 }, (_, i) => `{"jsonrpc":"2.0","id":${i},"method":"work"}`);
    const running = runServe(lines, { handlers, maxConcurrent: 2, requestTimeoutMs: 5000 });
    const releaseTimer = setTimeout(() => release.resolve(), 60);
    const { outLines } = await running;
    clearTimeout(releaseTimer);
    expect(outLines).toHaveLength(5);
  });
});
