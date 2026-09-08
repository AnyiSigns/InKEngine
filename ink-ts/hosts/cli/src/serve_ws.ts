/**
 * serve /ws 事件订阅通道（ws 协议适配层）。
 *
 * 帧协议：
 * - 客户端 → 服务端：`{"type":"subscribe","topics":["events.*","state.*",...]}`
 *   （重复 subscribe 覆盖旧 topics）；服务端回 `{"type":"subscribed","topics":[...]}`。
 * - 服务端 → 客户端：`{"type":"event","topic":"events.<type>|state.<name>","data":{...}}`；
 *   非法帧回 `{"type":"error","message":...}`。
 * 鉴权：/ws?token=<token> 或 ink_ts_token cookie；失败回 401 并断开。
 */

import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import { EventHub, type HubMessage, type HubSubscription } from './events_hub.js';
import { isAuthorized } from './serve_auth.js';

const TOKEN_QUERY = 'token';

function queryToken(url: string | undefined): string | null {
  if (url === undefined) return null;
  const search = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const params = new URLSearchParams(search);
  const value = params.get(TOKEN_QUERY);
  return value === null ? '' : value;
}

function sendJson(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

/** 把一条 hub 消息帧化为 `{"type":"event","topic":...,"data":...}`。 */
function sinkFor(ws: WebSocket): (message: HubMessage) => void {
  return (message) => {
    sendJson(ws, { type: 'event', topic: message.topic, data: message.data });
  };
}

export interface WsChannel {
  /** 关闭所有 ws 连接并解挂 http upgrade 监听。 */
  close(): Promise<void>;
}

/**
 * 在 http server 上挂接 /ws upgrade 通道。
 * @returns 通道句柄（stop 时 close）。
 */
export function attachWsChannel(server: HttpServer, hub: EventHub, token: string): WsChannel {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const subscriptions = new Set<HubSubscription>();

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const pathname = (req.url ?? '').split('?')[0] ?? '';
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const query = queryToken(req.url);
    if (!isAuthorized(req, token, query)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    let subscription: HubSubscription | null = null;
    ws.on('message', (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        sendJson(ws, { type: 'error', message: '非法 JSON 帧' });
        return;
      }
      const record = frame as { type?: unknown; topics?: unknown } | null;
      if (
        typeof record !== 'object'
        || record === null
        || record.type !== 'subscribe'
        || !Array.isArray(record.topics)
        || record.topics.some((topic) => typeof topic !== 'string' || topic === '')
      ) {
        sendJson(ws, { type: 'error', message: 'subscribe 帧需 {type:"subscribe", topics:[...]}' });
        return;
      }
      const topics = record.topics as string[];
      subscription?.close();
      subscription = hub.subscribe(topics, sinkFor(ws));
      subscriptions.add(subscription);
      sendJson(ws, { type: 'subscribed', topics });
      // state.* 就绪快照（订阅方按需处理；若无 state.* 订阅由 hub 侧过滤）
      hub.publish('state.server', { status: 'listening' });
    });
    ws.on('close', () => {
      sockets.delete(ws);
      if (subscription !== null) {
        subscriptions.delete(subscription);
        subscription.close();
      }
    });
    ws.on('error', () => {
      sockets.delete(ws);
      if (subscription !== null) {
        subscriptions.delete(subscription);
        subscription.close();
      }
    });
  });

  return {
    close: async (): Promise<void> => {
      server.off('upgrade', onUpgrade);
      for (const ws of [...sockets]) {
        try {
          ws.terminate();
        } catch {
          // 连接已关闭
        }
      }
      sockets.clear();
      for (const subscription of subscriptions) subscription.close();
      subscriptions.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
