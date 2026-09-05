/**
 * stdio 形态 e2e：spawn cli → host.ping/host.info + rounds.send 回合请求 →
 * 事件流响应（events 摘要含回合事件类型），stdin 关闭后优雅退出（exit 0）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, describe, expect, it } from 'vitest';

import { spawnCli } from './_spawn.js';

const STUB_REPLY = '（cli stub 回合已执行）';

interface StdioRequest {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioSession {
  readonly child: ReturnType<typeof spawnCli>;
  private readonly pending = new Map<number | string, (reply: StdioRequest) => void>();

  constructor(child: ReturnType<typeof spawnCli>) {
    this.child = child;
    const rl = createInterface({ input: child.proc.stdout });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let message: StdioRequest;
      try {
        message = JSON.parse(trimmed) as StdioRequest;
      } catch {
        return;
      }
      if (message && 'id' in message && message.id !== undefined) {
        const resolve = this.pending.get(message.id);
        if (resolve !== undefined) {
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    });
  }

  request(id: number | string, method: string, params?: unknown): Promise<StdioRequest> {
    return new Promise<StdioRequest>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`stdio 请求超时: ${method}`));
      }, 60_000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method };
      if (params !== undefined) payload['params'] = params;
      this.child.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async close(): Promise<{ stdout: string; exitCode: number | null }> {
    this.child.proc.stdin.end();
    const result = await this.child.waitClose(60_000);
    return { stdout: result.stdout, exitCode: result.exitCode };
  }
}

const sessions: StdioSession[] = [];

function startSession(): StdioSession {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-cli-stdio-e2e-'));
  const session = new StdioSession(spawnCli(['--data-dir', dir]));
  sessions.push(session);
  return session;
}

afterEach(async () => {
  const list = sessions.splice(0);
  for (const session of list) {
    try {
      session.child.kill();
    } catch {
      // 已退出
    }
    try {
      await session.child.waitClose(5_000);
    } catch {
      // 关停失败也接受（测试收尾兜底）
    }
  }
});

describe('stdio e2e（host bridge 注入 + 回合事件流响应）', () => {
  it('host.ping / host.info / rounds.send 事件流响应全链路', async () => {
    const session = startSession();

    const ping = await session.request(1, 'host.ping');
    expect(ping.result).toBe('pong');

    const info = await session.request(2, 'host.info');
    expect(info.result).toMatchObject({
      name: 'ink-ts-cli',
      protocol: 'json-rpc-2.0',
      approvals: 'explicit-only',
      autoApprove: false,
    });

    const round = await session.request(3, 'rounds.send', {
      input: 'e2e-stdio',
      trace_id: 'st-trace-1',
    });
    expect(round.error).toBeUndefined();
    const result = round.result as {
      thread_id: string;
      trace_id: string;
      reason: string;
      reply: string;
      events: { count: number; types: string[] };
    };
    expect(result.reason).toBe('reply');
    expect(result.reply).toBe(STUB_REPLY);
    expect(result.trace_id).toBe('st-trace-1');
    expect(result.events.count).toBeGreaterThan(0);
    expect(result.events.types).toContain('reply_token');

    // rounds 后 records.sessions 可见该会话（同一 host 装配实例）
    const sessionsView = await session.request(4, 'records.sessions');
    expect(sessionsView.error).toBeUndefined();
    const list = sessionsView.result as Array<{ thread_id: string }>;
    expect(list.some((item) => item.thread_id === result.thread_id)).toBe(true);

    // 未知方法回 -32601（协议兼容既有行为）
    const nope = await session.request(5, 'nope.method');
    expect(nope.error?.code).toBe(-32601);

    const closed = await session.close();
    expect(closed.exitCode).toBe(0);
  }, 90_000);
});
