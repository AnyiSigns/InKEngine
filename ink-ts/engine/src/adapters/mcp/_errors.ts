/**
 * MCP 适配器错误体系（镜像 Python mcp_client.py 的错误收敛面）。
 *
 * - McpToolImportError：MCP server 工具导入失败（连接/列表/转换/vetting
 *   任一环节报错）——继承 GraphDefinitionError，导入失败属定义期错误，
 *   宿主在挂载流程中捕获后转拒绝（不静默降级为「无工具」）；
 * - RpcError：server 返回的 JSON-RPC error 对象（结构化 code/message，
 *   业务拒绝判定 -32602 参数校验 / -32601 方法不存在等）；
 * - McpConnectionLost：自写传输的连接断流（子进程退出/EOF/管道破裂）。
 *
 * 分类判据（决定拉起后是否重试/透传）：业务错误（server 已受理返回
 * 结构化结论）不触发 stdio 拉起、不谎报「进程崩溃」；连接断流与
 * 取消（TaskCancelled）语义分置，供监督句柄精确收敛。
 */
import { GraphDefinitionError } from '../../core/errors.js';

/** MCP 工具导入失败（连接/列表/转换/vetting 任一环节报错）。 */
export class McpToolImportError extends GraphDefinitionError {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolImportError';
  }
}

/** server 返回的 JSON-RPC error（保留结构化 code/message 供业务拒绝判定）。 */
export class RpcError extends Error {
  readonly code: number;
  readonly rpc_message: string;

  constructor(code: number, message: string) {
    super(`MCP JSON-RPC 错误（code=${code}）: ${message}`);
    this.name = 'RpcError';
    this.code = code;
    this.rpc_message = message;
  }
}

/** 自写传输的连接断流（子进程退出/EOF/管道破裂/帧大小超限）。 */
export class McpConnectionLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionLost';
  }
}

/** 请求超时（RpcChannel 的上界语义；会话层收敛为调用超时错误文案）。 */
export class RpcTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcTimeout';
  }
}

/**
 * 任务取消（镜像 asyncio.CancelledError 的语义分置点）：监督句柄对
 * 其原样穿透，不误判为进程崩溃。TS 无内置可抛取消异常，适配器以
 * 此类型承载「外层取消」语义（宿主取消可经 abort seam 抛此异常）。
 */
export class TaskCancelled extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'TaskCancelled';
  }
}

/** 连接层断流判定（决定拉起后是否重试一次原操作）。 */
export function is_connection_lost(exc: unknown): boolean {
  if (exc instanceof McpConnectionLost) return true;
  const text = exc instanceof Error ? exc.message.toLowerCase() : String(exc).toLowerCase();
  return (
    text.includes('connection closed') ||
    text.includes('connection lost') ||
    text.includes('reset by peer') ||
    text.includes('broken pipe') ||
    text.includes('stream closed') ||
    text.includes('remote end closed')
  );
}

/** 业务失败判定（server 已受理并返回结构化错误——isError 结果/JSON-RPC
 *  error 的收敛文案均为「MCP 工具执行失败」前缀）：直接透传，不触发拉起。 */
export function is_business_error(exc: unknown): boolean {
  return exc instanceof Error && exc.message.includes('MCP 工具执行失败');
}
