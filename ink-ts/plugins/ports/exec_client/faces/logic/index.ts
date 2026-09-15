/**
 * exec_client 端口提供方插件（exec 原生机制件 client）。
 *
 * 端口实装位 exec_envelope（与 plugins/ports/mcp_client 的 stdio/进程 IO
 * 分工：本插件 = exec/infer/mcp 原生二进制的 client——定位 + 信封裁决面门 +
 * 受监督 stdio 会话；mcp_client = MCP 客户端进程 IO，勿混读）。S4 域组3 自
 * hosts/lib/src/exec/ 迁入（语义零改）：
 * - binary：exec/infer/ink_ts_mcp 原生命令二进制定位（声明真源
 *   plugins/endpoints/<id>/spec.json → native.generated.ts 派生，经
 *   @ink-ts/host 取型）；
 * - envelope：信封签名/校验（hmacHex/verifySignature）+ host 侧裁决面门
 *   （gateCoverage：越权/越根/未批准 = ExecRefusedError，进程不触达）+
 *   hostAllowed 检索出网白名单纯函数；
 * - client/session/transport：受监督 stdio 会话（spawn/看护/重启/熔断）+
 *   ExecClient 受监督 client（一次构造 = 一个会话密钥域，信封调用）；
 * - _types：信封/裁决/重启策略共享数据形态。
 *
 * 装载：hosts/lib 经 loadPortsSeam 取 execClient 窄面（locateNativeBinary
 * 定位面），域/命令插件（os/retrieval/search/doc_parse/dialog.open_directory）
 * 经跨树 import 本插件包取 ExecClient/SupervisedNativeSession/hostAllowed 等；
 * @ink-ts/host 停供 exec 值（只留 native.generated.ts 生成物声明面）。
 */

import { ExecClient, EXEC_SESSION_KEY_ENV } from './client.js';
import { binaryFileName, locateNativeBinary } from './binary.js';
import {
  buildSignedExecEnvelope,
  hmacHex,
  hostAllowed,
  isPathWithinRoots,
  pathHasDotdot,
  randomSessionKey,
  verifySignature,
} from './envelope.js';
import type { AdjudicatedDecision, ExecRequest } from './envelope.js';
import { SupervisedNativeSession } from './session.js';
import type { SessionOpener } from './session.js';
import { StdioProcessSession } from './transport.js';
import type { NativeSpawnOptions } from './transport.js';
import {
  DEFAULT_RESTART_POLICY,
  ExecRefusedError,
  RpcError,
  SessionLostError,
} from './_types.js';
import type {
  ExecDecision,
  ExecEnvelope,
  ExecOp,
  ExecOutcome,
  RestartPolicy,
} from './_types.js';
import type { NativeBinaryKind } from './_types.js';

export {
  DEFAULT_RESTART_POLICY,
  EXEC_SESSION_KEY_ENV,
  ExecClient,
  ExecRefusedError,
  RpcError,
  SessionLostError,
  StdioProcessSession,
  SupervisedNativeSession,
  binaryFileName,
  buildSignedExecEnvelope,
  hmacHex,
  hostAllowed,
  isPathWithinRoots,
  locateNativeBinary,
  pathHasDotdot,
  randomSessionKey,
  verifySignature,
};
export type {
  ExecDecision,
  ExecEnvelope,
  ExecOp,
  ExecOutcome,
  NativeBinaryKind,
  RestartPolicy,
} from './_types.js';
export type { AdjudicatedDecision, ExecRequest } from './envelope.js';
export type { SessionOpener } from './session.js';
export type { NativeSpawnOptions } from './transport.js';

/** S2/S4 端口提供方工厂（S0 装载契约）：exec_envelope 实装位 = exec 原生
 *  机制件 client 全 API（定位/信封裁决面门/受监督会话/共享形态）。 */
export default function createExecClientPort(): {
  ExecClient: typeof ExecClient;
  locateNativeBinary: typeof locateNativeBinary;
  hostAllowed: typeof hostAllowed;
  SupervisedNativeSession: typeof SupervisedNativeSession;
} {
  return {
    ExecClient,
    locateNativeBinary,
    hostAllowed,
    SupervisedNativeSession,
  };
}
