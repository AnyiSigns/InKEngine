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
  is_mcp_business_reject,
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
export {
  McpClientManager,
  register_mcp_executor,
  type McpVettingLike,
} from './manager.js';
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
