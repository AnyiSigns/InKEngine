/**
 * e2e 门禁：接线 e2e——spawn cli serve → /health → /rpc 鉴权 → ws 订阅 →
 * rounds.send 触发回合 → 实时收到 events.reply_token 事件帧。
 * 进程收尾 kill；全链路离线 stub 回合即可验证（无需 LLM）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { GateResult } from '../_report.js';
import { firstJsonLine, killTree, spawnLong } from '../_proc.js';
import type { SelfCheckContext } from '../index.js';

interface ListenLine {
  event: string;
  mode: string;
  url: string;
  ws: string;
  token: string;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ink-self-check-e2e-'));
}

async function startServe(ctx: SelfCheckContext): Promise<{ listen: ListenLine; stop: () => Promise<void> }> {
  const cliEntry = join(ctx.inkTsRoot, 'cli', 'src', 'index.ts');
  const token = `self-check-${randomBytes(6).toString('hex')}`;
  const child = spawnLong([process.execPath, '--import', 'tsx', cliEntry, 'serve', '--port', '0', '--data-dir', tempDir(), '--token', token], {
    cwd: ctx.inkTsRoot,
    timeoutMs: 60_000,
  });
  const line = (await firstJsonLine(child, 60_000)) as unknown as ListenLine;
  if (line.event !== 'listen' || line.mode !== 'serve') {
    killTree(child.proc);
    throw new Error(`serve 未按契约输出 listen 行: ${JSON.stringify(line)}`);
  }
  const stop = async (): Promise<void> => {
    killTree(child.proc);
    await child.waitClose(8_000);
  };
  return { listen: line, stop };
}

export async function runGateE2e(ctx: SelfCheckContext): Promise<GateResult> {
  const started = Date.now();
  const tail: string[] = [];
  let stopped = false;
  try {
    const { listen, stop } = await startServe(ctx);
    try {
      const health = await fetch(`${listen.url}/health`);
      const healthJson = (await health.json()) as { ok?: boolean };
      if (health.status !== 200 || healthJson.ok !== true) {
        return { key: 'e2e', label: '接线 e2e（serve→health+ws）', command: 'serve', passed: false, seconds: (Date.now() - started) / 1000, summary: '/health 异常', tail: [`/health ${health.status} ${JSON.stringify(healthJson)}`] };
      }

      const ping = await fetch(`${listen.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${listen.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'host.ping' }),
      });
      const pingJson = (await ping.json()) as { result?: unknown };
      if (ping.status !== 200 || pingJson.result !== 'pong') {
        return { key: 'e2e', label: '接线 e2e（serve→health+ws）', command: 'serve', passed: false, seconds: (Date.now() - started) / 1000, summary: 'host.ping 鉴权失败', tail: [`/rpc ${ping.status} ${JSON.stringify(pingJson)}`] };
      }

      const wsClient = await import('ws');
      const WebSocketCtor = (wsClient as { default: typeof import('ws').default }).default;
      const socket = new WebSocketCtor(`${listen.ws}?token=${encodeURIComponent(listen.token)}`);
      const frames: Array<Record<string, unknown>> = [];
      const frameWaiters: Array<{ match: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void; timer: NodeJS.Timeout }> = [];
      socket.on('message', (data: unknown) => {
        let frame: Record<string, unknown> | null = null;
        try {
          const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
          frame = JSON.parse(text) as Record<string, unknown>;
        } catch {
          frame = null;
        }
        if (frame === null) return;
        frames.push(frame);
        for (const waiter of [...frameWaiters]) {
          if (!waiter.match(frame)) continue;
          clearTimeout(waiter.timer);
          frameWaiters.splice(frameWaiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      });
      const waitFor = (match: (f: Record<string, unknown>) => boolean, label: string, ms = 30_000): Promise<Record<string, unknown>> =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const existing = frames.find(match);
          if (existing) {
            resolve(existing);
            return;
          }
          const timer = setTimeout(() => reject(new Error(`等待 ws 帧超时: ${label}`)), ms);
          frameWaiters.push({ match, resolve, timer });
        });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws 连接超时')), 15_000);
        socket.on('open', () => {
          clearTimeout(timer);
          socket.send(JSON.stringify({ type: 'subscribe', topics: ['events.*', 'state.*'] }));
          resolve();
        });
        socket.on('error', (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
      const subscribed = await waitFor((f) => f['type'] === 'subscribed', 'subscribed ack');
      if (!Array.isArray(subscribed['topics']) || !subscribed['topics'].includes('events.*')) {
        return { key: 'e2e', label: '接线 e2e（serve→health+ws）', command: 'serve', passed: false, seconds: (Date.now() - started) / 1000, summary: 'ws 订阅未确认 events.*', tail: [JSON.stringify(subscribed)] };
      }

      const eventPromise = waitFor(
        (f) => f['type'] === 'event' && typeof f['topic'] === 'string' && (f['topic'] as string).startsWith('events.reply_token'),
        'events.reply_token',
        30_000,
      );
      const round = await fetch(`${listen.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${listen.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'rounds.send',
          params: { input: 'self-check-e2e', trace_id: `self-check-${Date.now()}` },
        }),
      });
      const roundJson = (await round.json()) as { result?: { reply?: string }; error?: unknown };
      if (round.status !== 200 || roundJson.error !== undefined) {
        return { key: 'e2e', label: '接线 e2e（serve→health+ws）', command: 'serve', passed: false, seconds: (Date.now() - started) / 1000, summary: 'rounds.send 失败', tail: [`/rpc ${round.status} ${JSON.stringify(roundJson)}`] };
      }
      const eventFrame = await eventPromise;
      const topic = eventFrame['topic'] as string;
      const data = (eventFrame['data'] ?? {}) as { type?: string; payload?: unknown };
      if (data['type'] !== 'reply_token' || typeof data['payload'] !== 'object') {
        return { key: 'e2e', label: '接线 e2e（serve→health+ws）', command: 'serve', passed: false, seconds: (Date.now() - started) / 1000, summary: '事件帧载荷异常', tail: [JSON.stringify(eventFrame)] };
      }

      return {
        key: 'e2e',
        label: '接线 e2e（serve→health+ws）',
        command: 'serve',
        passed: true,
        seconds: (Date.now() - started) / 1000,
        summary: `/health + 鉴权 ping + ws 订阅 + rounds.send → ${topic} 实时事件帧`,
        tail,
      };
    } finally {
      if (!stopped) {
        stopped = true;
        await stop();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { key: 'e2e', label: '接线 e2e（serve→health+ws）', command: 'serve', passed: false, seconds: (Date.now() - started) / 1000, summary: `异常: ${message}`, tail: [message] };
  }
}
