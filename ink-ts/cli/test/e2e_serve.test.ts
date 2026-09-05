/**
 * serve 形态 e2e：健康检查 + /rpc 鉴权 + ws 事件订阅到引擎事件全链路。
 *
 * 流程：spawn cli serve（随机端口）→ 读 listen 行（url/ws/token）→
 * /health 200 → /rpc 无 token 401、带 token 正常 → ws 订阅 events.* 与 state.*
 * → /rpc rounds.send 触发回合 → ws 收到 events.reply_token 实时事件帧；
 * 收尾 kill 子进程。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { RawData } from 'ws';

import { firstJsonLine, spawnCli, type CliChild } from './_spawn.js';

const TEST_TOKEN = 'serve-e2e-token-0123456789abcdef';
const STUB_REPLY = '（cli stub 回合已执行）';

interface ListenLine {
  event: string;
  mode: string;
  url: string;
  ws: string;
  token: string;
}

interface WsFrame {
  type: string;
  topic?: string;
  data?: Record<string, unknown>;
  topics?: string[];
}

const children: CliChild[] = [];

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ink-cli-serve-e2e-'));
}

async function startServe(): Promise<{ listen: ListenLine; child: CliChild }> {
  const child = spawnCli(['serve', '--port', '0', '--data-dir', tempDir(), '--token', TEST_TOKEN]);
  children.push(child);
  const listen = (await firstJsonLine(child, 60_000)) as unknown as ListenLine;
  expect(listen.event).toBe('listen');
  expect(listen.mode).toBe('serve');
  expect(listen.token).toBe(TEST_TOKEN);
  return { listen, child };
}

async function stopServe(child: CliChild): Promise<void> {
  try {
    child.kill();
  } catch {
    // 已退出
  }
  try {
    await child.waitClose(8_000);
  } catch {
    // 收尾兜底
  }
}

afterEach(async () => {
  const list = children.splice(0);
  for (const child of list) await stopServe(child);
});

function toFrame(data: RawData): WsFrame | null {
  try {
    const frame = JSON.parse(data.toString()) as WsFrame;
    return typeof frame.type === 'string' ? frame : null;
  } catch {
    return null;
  }
}

/** 打开 ws 并订阅；返回连接 + 帧谓词等待器（订阅后先挂等待再触发回合）。 */
function openSubscription(listen: ListenLine): {
  ws: WebSocket;
  waitFor(predicate: (frame: WsFrame) => boolean, label: string): Promise<WsFrame>;
} {
  const ws = new WebSocket(`${listen.ws}?token=${encodeURIComponent(listen.token)}`);
  const waiters: Array<{ predicate: (frame: WsFrame) => boolean; resolve: (frame: WsFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  ws.on('message', (data) => {
    const frame = toFrame(data);
    if (frame === null) return;
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
      break;
    }
  });
  ws.on('error', () => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('ws 连接错误'));
    }
    waiters.length = 0;
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', topics: ['events.*', 'state.*'] }));
  });
  return {
    ws,
    waitFor: (predicate, label) =>
      new Promise<WsFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 ws 帧超时: ${label}`)), 30_000);
        waiters.push({ predicate, resolve, reject, timer });
      }),
  };
}

describe('serve e2e：健康检查与鉴权', () => {
  it('健康检查 200；/rpc 无 token 401、带 token 正常；静态根可访问', async () => {
    const { listen, child } = await startServe();
    try {
      const health = await fetch(`${listen.url}/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

      const unauthorized = await fetch(`${listen.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'host.ping' }),
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`${listen.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${listen.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'host.ping' }),
      });
      expect(authorized.status).toBe(200);
      const ping = (await authorized.json()) as { result: string };
      expect(ping.result).toBe('pong');

      const info = await fetch(`${listen.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ink-token': listen.token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'host.info' }),
      });
      const infoBody = (await info.json()) as { result: { approvals: string } };
      expect(infoBody.result.approvals).toBe('explicit-only');

      const root = await fetch(`${listen.url}/`);
      expect(root.status).toBe(200);
      expect(await root.text()).toContain('ink-ts cli serve');
    } finally {
      await stopServe(child);
    }
  }, 120_000);
});

describe('serve e2e：ws 事件订阅到引擎事件', () => {
  it('订阅 events.*/state.* → /rpc rounds.send → 实时收到 reply_token 事件帧', async () => {
    const { listen, child } = await startServe();
    try {
      const sub = openSubscription(listen);
      const subscribed = await sub.waitFor((frame) => frame.type === 'subscribed', 'subscribed ack');
      expect(subscribed.topics ?? []).toContain('events.*');

      // 先挂事件等待再触发回合（防快速回合错过事件）
      const replyToken = sub.waitFor(
        (frame) => frame.type === 'event' && (frame.topic ?? '').startsWith('events.reply_token'),
        'events.reply_token',
      );
      const response = await fetch(`${listen.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${listen.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'rounds.send',
          params: { input: 'serve-e2e', trace_id: 'serve-trace-1' },
        }),
      });
      expect(response.status).toBe(200);
      const round = (await response.json()) as { result?: { reply: string }; error?: unknown };
      expect(round.error).toBeUndefined();
      expect(round.result?.reply).toBe(STUB_REPLY);

      const frame = await replyToken;
      expect(frame.topic).toBe('events.reply_token');
      expect((frame.data ?? {})['type']).toBe('reply_token');
      expect(typeof (frame.data ?? {})['payload']).toBe('object');
    } finally {
      await stopServe(child);
    }
  }, 120_000);
});
