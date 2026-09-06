/**
 * 内存 MCP 传输直测（in_memory：宿主无激活路径的「预留实现」语义由本测试
 * 兜底——create_message_duplex_pair 建 echo 服务端，零网络/进程验证握手/
 * 工具列举/调用/ping 全链路）。
 */
import { describe, expect, it } from 'vitest';

import {
  McpServerConfig,
  McpTransport,
  MemoryMcpTransport,
  create_message_duplex_pair,
  type McpMessagePort,
} from '../../../src/adapters/mcp/index.js';

const SERVER_INFO = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  serverInfo: { name: 'mem-echo', version: '1' },
};

const ECHO_TOOL = {
  name: 'echo_text',
  description: 'echo a text',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
  },
};

/** 最小 in_memory 服务端：应答 initialize/tools/list/tools/call/ping。 */
async function run_echo_server(port: McpMessagePort): Promise<void> {
  for await (const msg of port.read) {
    if (msg === null || msg === undefined) continue;
    const id = msg['id'];
    if (id === undefined) continue; // 通知（notifications/initialized）忽略
    const method = msg['method'];
    let payload: Record<string, unknown>;
    if (method === 'initialize') {
      payload = { jsonrpc: '2.0', id, result: SERVER_INFO };
    } else if (method === 'tools/list') {
      payload = { jsonrpc: '2.0', id, result: { tools: [ECHO_TOOL] } };
    } else if (method === 'tools/call') {
      const args = (msg['params'] as Record<string, unknown> | undefined)?.['arguments'];
      payload = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: String((args as Record<string, unknown> | undefined)?.['text'] ?? '') }],
          isError: false,
        },
      };
    } else if (method === 'ping') {
      payload = { jsonrpc: '2.0', id, result: {} };
    } else {
      payload = { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
    }
    await port.write(payload);
  }
}

const transport_config = (server: McpMessagePort): McpServerConfig =>
  new McpServerConfig({
    id: 'mem',
    transport: McpTransport.IN_MEMORY,
    server_factory: async () => server,
  });

describe('MemoryMcpTransport（in_memory echo）', () => {
  it('握手 + 工具列举 + 调用 + ping 全链路', async () => {
    const [client, server] = create_message_duplex_pair();
    const serverTask = run_echo_server(server);
    const transport = new MemoryMcpTransport(transport_config(server), client);
    await transport.start();
    expect(transport._server_info).toEqual(SERVER_INFO);
    const tools = await transport.list_tools();
    expect(tools.map((t) => t['name'])).toEqual(['echo_text']);
    const result = await transport.call_tool('echo_text', { text: 'hi' });
    const content = (result['content'] as { text: string }[])[0];
    expect(content?.['text']).toBe('hi');
    await transport.ping();
    await transport.aclose();
    // 客户端会话已关：宿主侧收尾同端 server 端口（in_memory 无进程 EOF，
    // 收方向经 close 哨兵结束，echo 读循环据此退出）
    server.close?.();
    await serverTask;
  });
});
