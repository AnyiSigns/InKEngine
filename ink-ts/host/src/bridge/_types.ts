/**
 * host bridge 数据类型（命令面信封形态）。
 *
 * JSON-RPC 信封错误只回通用、细节走 diag（复用 cli/diag 样式：envelope
 * 层把 handler 异常归一 -32603 generic，本层只声明错误载体与「细节」数据，
 * 不做信封 IO）。BridgeHandler 与 cli 现有 handler 形态结构一致
 * （(params, ctx) => result），host 不 import cli（依赖方向单向下）。
 */

import type { Runtime } from '@ink-ts/engine';

import type { InkHost } from '../host.js';

/** bridge 处理器上下文（与 cli rpc HandlerContext 结构一致，供 cli 直接并入命令面）。 */
export interface BridgeContext {
  autoApprove: boolean;
  signal?: AbortSignal;
}

/** bridge 处理器（方法实现；结果须 JSON 可序列化）。 */
export type BridgeHandler = (
  params: unknown,
  ctx: BridgeContext,
) => Promise<unknown> | unknown;

/** 业务/参数错误载体：message 可回给请求方（非内部异常细节），code 供归类。 */
export class BridgeError extends Error {
  readonly code: string;
  /** 可选细节（诊断面；envelope 不回给客户端，细节走 diag）。 */
  readonly details: unknown;

  constructor(message: string, code = 'bridge_error', details: unknown = null) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

/** 会话索引集合（宿主薄服务数据所在存储集合键；rounds 收尾 upsert）。 */
export const HOST_SESSIONS_COLLECTION = 'host.sessions';

/** 单条会话索引记录（rounds.send 回合收尾 upsert）。 */
export interface HostSessionRecord {
  thread_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  round_count: number;
  last_round_id: string | null;
}

/** bridge 依赖（createHost 装配产物；rounds/records/approval/audit 消费）。 */
export interface HostBridgeDeps {
  runtime: Runtime;
  host: InkHost;
  autoApprove: boolean;
  /** 最近在途 run 取消句柄登记（rounds.abort 经 runtime 中止）。 */
}
