/**
 * 最小宿主方法集合。host.info 向调用方声明宿主能力（含审批姿态）；
 * 后续引擎接线（L2+）在此扩展，方法集合变化同步工具/声明文档。
 */

import type { Handler, HandlerContext } from './rpc.js';

export interface HostInfo {
  name: string;
  protocol: 'json-rpc-2.0';
  approvals: 'explicit-only';
  autoApprove: boolean;
}

export function buildHandlers(): ReadonlyMap<string, Handler> {
  return new Map<string, Handler>([
    ['host.ping', () => 'pong'],
    [
      'host.info',
      (_params: unknown, ctx: HandlerContext): HostInfo => ({
        name: 'ink-ts-cli',
        protocol: 'json-rpc-2.0',
        approvals: 'explicit-only',
        autoApprove: ctx.autoApprove,
      }),
    ],
  ]);
}
