/**
 * 适配层 mcp 包公开面（镜像 Python ink_engine/core/mcp_client.py 的
 * __all__，另含测试/宿主需要的传输级内部形态）。
 *
 * 结构边界：
 * - config/registry：配置数据形态与内置 server 注册表；
 * - convert/_result：纯函数转换与结果文本收敛；
 * - _framing/_rpc_channel：帧协议/消息通道（stdio/内存共用协议面）；
 * - stdio_transport/http_transport/memory_transport：三种传输形态；
 * - session/supervised：会话句柄与 stdio 进程监督；
 * - manager：连接管理器 + 分发执行器注册。
 */
export { McpTransport, McpServerConfig, StdioRestartPolicy } from './config.js';
export { BUILTIN_MCP_SERVERS, builtin_mcp_server_config } from './registry.js';
export {
  build_mcp_manifest,
  convert_mcp_tool,
  normalize_input_schema,
  probe_args_from_schema,
} from './convert.js';
export { extract_text, result_is_error } from './_result.js';
export {
  McpToolImportError,
  RpcError,
  McpConnectionLost,
  RpcTimeout,
  TaskCancelled,
  is_business_error,
  is_connection_lost,
} from './_errors.js';
export {
  CALL_TIMEOUT,
  CONNECT_TIMEOUT,
  CONTENT_LENGTH_FRAMING,
  JSON_LINES_FRAMING,
  MAX_STDIO_FRAME_BYTES,
  ByteReader,
  encode_mcp_frame,
  exec_line_is_error,
  parse_content_length,
  read_messages,
} from './_framing.js';
export {
  RpcChannel,
  create_message_duplex_pair,
  with_timeout,
} from './_rpc_channel.js';
export { StdioMcpTransport, create_node_spawn_seam } from './stdio_transport.js';
export {
  HttpMcpTransport,
  parse_sse_events,
  type FetchLike,
  type FetchResponseLike,
} from './http_transport.js';
export { MemoryMcpTransport } from './memory_transport.js';
export {
  SdkSession,
  McpSessionHandle,
  type SessionOpenOptions,
} from './session.js';
export {
  AsyncLock,
  SupervisedStdioSession,
  type SessionOpener,
} from './supervised.js';
export { McpClientManager, register_mcp_executor, type McpVettingLike } from './manager.js';
export { create_node_fs_seam } from './_fs_seam.js';
export type {
  McpCallResult,
  McpJsonRpcMessage,
  McpMessagePort,
  McpToolRecord,
  RawMcpSession,
  ServerFactory,
  SpawnedMcpProcess,
  SpawnSeam,
} from './_types.js';

import { McpClientManager, register_mcp_executor } from './manager.js';
import { McpTransport, McpServerConfig, StdioRestartPolicy } from './config.js';
import { BUILTIN_MCP_SERVERS, builtin_mcp_server_config } from './registry.js';
import { StdioMcpTransport, create_node_spawn_seam } from './stdio_transport.js';
import { HttpMcpTransport } from './http_transport.js';
import { MemoryMcpTransport } from './memory_transport.js';
import { SdkSession } from './session.js';
import { SupervisedStdioSession } from './supervised.js';
import { extract_text, result_is_error } from './_result.js';
import { create_node_fs_seam } from './_fs_seam.js';

/**
 * S0 端口提供方默认导出 = 端口实现工厂（`(init?) => 端口实现实例`，装载器
 * 只装载不解析；mcp 实例 = 连接管理器/传输/注册执行器面，仓库装配取用）。
 */
export default function createMcpPort(): Record<string, unknown> {
  return {
    McpClientManager,
    register_mcp_executor,
    McpTransport,
    McpServerConfig,
    StdioRestartPolicy,
    BUILTIN_MCP_SERVERS,
    builtin_mcp_server_config,
    StdioMcpTransport,
    HttpMcpTransport,
    MemoryMcpTransport,
    SdkSession,
    SupervisedStdioSession,
    extract_text,
    result_is_error,
    create_node_fs_seam,
    create_node_spawn_seam,
  };
}
