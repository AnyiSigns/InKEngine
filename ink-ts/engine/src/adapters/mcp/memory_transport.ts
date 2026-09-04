/**
 * 内存 MCP 传输（镜像 Python 的 in_memory 分支：宿主注入 server_factory，
 * 内嵌 server/测试桩，零网络/进程）。
 *
 * TS 差异：Python 的 factory 产出 SDK 内存消息流对；本适配器无 mcp SDK，
 * factory 契约 = 消息级双工端口（McpMessagePort：read 收方向异步可迭代、
 * write 发方向）——宿主以 create_message_duplex_pair 构造客户端/服务端
 * 成对端口（或自实现），会话驱动与 stdio 共用 RpcChannel 消息层。
 */
import { RpcChannel } from './_rpc_channel.js';
import {
  CALL_TIMEOUT,
  CONNECT_TIMEOUT,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
} from './_framing.js';
import type {
  McpCallResult,
  McpMessagePort,
  McpToolRecord,
  RawMcpSession,
} from './_types.js';
import type { McpServerConfig } from './config.js';

/** 内存传输（RawMcpSession 形态；open 期完成握手）。 */
export class MemoryMcpTransport implements RawMcpSession {
  readonly _config: McpServerConfig;
  readonly _channel: RpcChannel;
  readonly _port: McpMessagePort;
  _server_info: Record<string, unknown> | null = null;
  _closed = false;

  constructor(config: McpServerConfig, port: McpMessagePort) {
    this._config = config;
    this._port = port;
    this._channel = new RpcChannel(port, config.id);
  }

  async start(): Promise<void> {
    this._channel.start();
    const result = await this._channel.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      },
      Math.round(CONNECT_TIMEOUT * 1000),
    );
    this._server_info =
      typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>)
        : null;
    this._channel.notify('notifications/initialized', {});
  }

  async list_tools(): Promise<McpToolRecord[]> {
    const result = await this._channel.request(
      'tools/list',
      {},
      Math.round(CALL_TIMEOUT * 1000),
    );
    if (typeof result !== 'object' || result === null) return [];
    const tools = (result as Record<string, unknown>)['tools'];
    return Array.isArray(tools) ? (tools as McpToolRecord[]) : [];
  }

  async call_tool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const result = await this._channel.request(
      'tools/call',
      { name, arguments: arguments_ ?? {} },
      Math.round(CALL_TIMEOUT * 1000),
    );
    if (typeof result !== 'object' || result === null) {
      return { content: [{ type: 'text', text: String(result) }], isError: false };
    }
    return result as McpCallResult;
  }

  async ping(): Promise<void> {
    await this._channel.request('ping', {}, Math.round(CALL_TIMEOUT * 1000));
  }

  async aclose(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._channel.close();
    await this._channel.join();
  }
}
