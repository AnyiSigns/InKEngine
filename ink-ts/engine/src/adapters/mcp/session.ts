/**
 * MCP 会话句柄与真实会话打开（镜像 Python mcp_client.py 的 McpSessionHandle /
 * _SdkSession.open 语义）。
 *
 * - McpSessionHandle：已连接会话的句柄（按 server_id 路由；分发执行器
 *   据此调用）——抽象出 list_tools/call_tool/aclose 三个能力，测试以假
 *   实现替换真实会话（不依赖网络/进程即可验证转换与分发逻辑）；
 * - SdkSession：按配置打开真实会话的句柄——stdio 走自写子进程传输、
 *   http 走自写 fetch 传输、in_memory 走宿主注入的消息端口；会话层收敛
 *   业务结论：JSON-RPC 业务拒绝（-32602 等）与结果 is_error → 明确业务
 *   错误文案（MCP 工具执行失败，不当作进程崩溃传播），连接层异常透传
 *   交监督句柄处理，调用/列举超时收敛为导入错误文案。
 *
 * 超时上界统一：连接 CONNECT_TIMEOUT、调用 CALL_TIMEOUT（秒）。
 */
import { GraphDefinitionError } from '../../core/errors.js';
import { McpToolImportError, RpcError, RpcTimeout } from './_errors.js';
import { CALL_TIMEOUT } from './_framing.js';
import { extract_text, result_is_error } from './_result.js';
import { HttpMcpTransport, type FetchLike } from './http_transport.js';
import { MemoryMcpTransport } from './memory_transport.js';
import { StdioMcpTransport } from './stdio_transport.js';
import type { McpCallResult, McpToolRecord, RawMcpSession, SpawnSeam } from './_types.js';
import type { McpServerConfig } from './config.js';

/** 会话句柄（抽象能力面；list_tools 返回原始工具形态）。 */
export abstract class McpSessionHandle {
  abstract list_tools(): Promise<McpToolRecord[]>;

  abstract call_tool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string>;

  abstract aclose(): Promise<void>;
}

/** 带协议级存活探测能力的句柄（health_check 的判定依据；可选能力）。 */
export interface McpPingable {
  ping(): Promise<void>;
}

/** 会话打开选项（传输 seam 注入面：spawn/fetch/执行件 stderr 通道）。 */
export interface SessionOpenOptions {
  spawn_seam?: SpawnSeam;
  fetch_impl?: FetchLike;
  on_exec_line?: (level: 'error' | 'info', line: string) => void;
}

/** 异常 → 文案（统一包装错误消息形态）。 */
export function _detail(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 真实会话句柄（stdio = 自写子进程传输；http = 自写 fetch 传输；
 * in_memory = 宿主注入消息端口）。会话层收敛业务结论并做文本提取。
 */
export class SdkSession extends McpSessionHandle {
  readonly _transport: RawMcpSession;
  readonly _server_id: string;

  constructor(server_id: string, transport: RawMcpSession) {
    super();
    this._server_id = server_id;
    this._transport = transport;
  }

  /** 按配置打开真实会话（stdio 自写传输，其余传输自写 fetch/消息端口）。 */
  static async open(
    config: McpServerConfig,
    opts: SessionOpenOptions = {},
  ): Promise<SdkSession> {
    const value = config.transport;
    if (value === 'stdio') {
      if (!config.command) {
        throw new McpToolImportError(
          `MCP server ${config.id} 的 stdio 传输缺 command`,
        );
      }
      const transport = new StdioMcpTransport(config, {
        spawn_seam: opts.spawn_seam,
        on_exec_line: opts.on_exec_line,
      });
      try {
        await transport.start();
      } catch (exc) {
        if (exc instanceof McpToolImportError) throw exc;
        throw new McpToolImportError(
          `MCP server ${config.id} stdio 连接失败: ${_detail(exc)}`,
        );
      }
      return new SdkSession(config.id, transport);
    }
    try {
      if (value === 'http') {
        if (!config.url) {
          throw new McpToolImportError(
            `MCP server ${config.id} 的 http 传输缺 url`,
          );
        }
        const transport = new HttpMcpTransport(config, {
          fetch_impl: opts.fetch_impl,
        });
        await transport.start();
        return new SdkSession(config.id, transport);
      }
      if (value === 'in_memory') {
        if (config.server_factory === null) {
          throw new McpToolImportError(
            `MCP server ${config.id} 的内存传输缺 server_factory`,
          );
        }
        const port = await config.server_factory();
        const transport = new MemoryMcpTransport(config, port);
        await transport.start();
        return new SdkSession(config.id, transport);
      }
      throw new McpToolImportError(
        `MCP server ${config.id} 的传输形态未支持: ${config.transport}`,
      );
    } catch (exc) {
      if (exc instanceof McpToolImportError) throw exc;
      throw new McpToolImportError(`MCP server ${config.id} 连接失败: ${_detail(exc)}`);
    }
  }

  async list_tools(): Promise<McpToolRecord[]> {
    try {
      return await this._transport.list_tools();
    } catch (exc) {
      if (exc instanceof RpcTimeout) {
        throw new McpToolImportError(`MCP 工具列举超时（${CALL_TIMEOUT} 秒）`);
      }
      throw exc;
    }
  }

  async call_tool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    let result: McpCallResult;
    try {
      result = await this._transport.call_tool(name, args ?? {});
    } catch (exc) {
      if (exc instanceof RpcTimeout) {
        throw new GraphDefinitionError(
          `MCP 工具调用超时: ${name}（${CALL_TIMEOUT} 秒）`,
        );
      }
      // server 业务拒绝（JSON-RPC error：-32602 参数校验等）→ 明确业务错误
      if (exc instanceof RpcError) {
        throw new GraphDefinitionError(`MCP 工具执行失败: ${name}: ${exc.message}`);
      }
      throw exc; // 连接层异常透传，交监督句柄处理
    }
    if (result_is_error(result)) {
      throw new GraphDefinitionError(
        `MCP 工具执行失败: ${name}: ${extract_text(result)}`,
      );
    }
    return extract_text(result);
  }

  /** 协议级存活探测（health_check 的判定依据）。 */
  async ping(): Promise<void> {
    try {
      await this._transport.ping();
    } catch (exc) {
      if (exc instanceof RpcTimeout) {
        throw new McpToolImportError(`MCP ping 超时（${CALL_TIMEOUT} 秒）`);
      }
      throw exc;
    }
  }

  async aclose(): Promise<void> {
    try {
      await this._transport.aclose();
    } catch {
      // 关闭失败是清理噪音，不影响调用面
    }
  }
}
