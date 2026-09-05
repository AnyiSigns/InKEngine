/**
 * 最小宿主方法集合 = host.ping/host.info + host bridge 方法表并入。
 *
 * buildHandlers 委托装配产物：cli 冷启一次 createHost（见 host.ts），把
 * bridge 方法表（rounds、records、approval、audit.export 等域）并入命令面，
 * 保留 host.ping/host.info（stdio JSON-RPC 信封兼容现有协议）。host.info
 * 向调用方声明宿主能力（含审批姿态）；方法集合任何增删改都要同步工具/
 * 声明清单文档（AGENTS 纪律 3）。
 */

import type { BridgeHandler } from '@ink-ts/host';

import type { Handler, HandlerContext } from './rpc.js';

export interface HostInfo {
  name: string;
  protocol: 'json-rpc-2.0';
  /** approvals 值（explicit-only）：审批放行仅在 --approve 显式声明时成立。 */
  approvals: 'explicit-only';
  autoApprove: boolean;
}

export interface BuildHandlersDeps {
  /** host bridge 方法表（createHost 产物；缺省 = 仅 ping/info 的最小面）。 */
  bridge?: ReadonlyMap<string, BridgeHandler>;
}

export function buildHandlers(deps: BuildHandlersDeps = {}): ReadonlyMap<string, Handler> {
  const handlers = new Map<string, Handler>();
  handlers.set('host.ping', () => 'pong');
  handlers.set(
    'host.info',
    (_params: unknown, ctx: HandlerContext): HostInfo => ({
      name: 'ink-ts-cli',
      protocol: 'json-rpc-2.0',
      approvals: 'explicit-only',
      autoApprove: ctx.autoApprove,
    }),
  );
  for (const [method, bridgeHandler] of deps.bridge ?? []) {
    handlers.set(method, bridgeHandler as Handler);
  }
  return handlers;
}
