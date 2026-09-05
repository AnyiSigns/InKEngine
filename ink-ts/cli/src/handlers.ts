/**
 * 最小宿主方法集合。host.info 向调用方声明宿主能力（含审批姿态）；
 * 方法集合的任何增删改都要同步工具/声明清单文档；approvals 语义值的
 * 单一事实源方向在 contracts 层，宿主此处仅为透传。
 */

import type { Handler, HandlerContext } from './rpc.js';

export interface HostInfo {
  name: string;
  protocol: 'json-rpc-2.0';
  /** approvals 值（explicit-only）见文件头注释：单一事实源方向在 contracts 层。 */
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
