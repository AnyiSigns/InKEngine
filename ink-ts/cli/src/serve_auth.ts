/**
 * serve 形态本地 http/ws 鉴权与请求解析（回环 token）。
 *
 * 鉴权形态（本阶段自定，T6 web 按此契约接入）：
 * - /rpc   ：`Authorization: Bearer <token>` 或 `x-ink-token: <token>`
 *   或 `ink_ts_token` cookie（serve 在静态响应 Set-Cookie，同源浏览器可用）；
 * - /ws    ：`?token=<token>` 或 `ink_ts_token` cookie（浏览器 WS 无法自设头）；
 * - /health 与静态文件不回环鉴权（监听默认 127.0.0.1 回环）；/rpc、/ws 之外
 *   无 token 一律 401（fail-closed）。token 每进程随机生成（--token 可显式覆盖）。
 */

import type { IncomingMessage } from 'node:http';

import { timingSafeEqual } from 'node:crypto';

/** 提取 token：query token 优先，其次 x-ink-token / Authorization Bearer / cookie。 */
export function extractToken(req: IncomingMessage, queryToken: string | null = null): string | null {
  if (queryToken !== null && queryToken !== '') return queryToken;
  const headers = req.headers;
  const direct = headers['x-ink-token'];
  if (typeof direct === 'string' && direct !== '') return direct;
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match !== null) return (match[1] ?? '').trim();
  }
  const cookie = headers['cookie'];
  if (typeof cookie === 'string') {
    const found = /(?:^|;\s*)ink_ts_token=([^;]+)/.exec(cookie);
    if (found !== null) return decodeURIComponent((found[1] ?? '').trim());
  }
  return null;
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 常量时间 token 校验（长度不等即拒绝，无泄漏）。 */
export function isAuthorized(req: IncomingMessage, expected: string, queryToken: string | null = null): boolean {
  const token = extractToken(req, queryToken);
  return token !== null && token !== '' && sameToken(token, expected);
}
