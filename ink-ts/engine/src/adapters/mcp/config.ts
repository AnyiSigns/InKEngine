/**
 * MCP server 连接配置（数据形态，可持久化进集数据通道）——镜像 Python
 * mcp_client.py 的 McpTransport/StdioRestartPolicy/McpServerConfig。
 *
 * 安全要点：
 * - headers/env 自 repr 遮蔽（TS 端承载于 toString，凭据不落日志/调试输出）；
 * - to_dict(redact_credentials=True) 以 [REDACTED] 占位鉴权值——持久化/
 *   审计等不恢复连接形态的落库路径显式传 True，避免明文留存；配置往返
 *   （需还原重连）保持 False；
 * - from_dict 对非法形态（缺 id/非法传输/非法来源/字段类型错误/未知
 *   stdio 帧协议）显式拒绝（fail-closed）。
 */
import { GraphDefinitionError } from '../../core/errors.js';
import { ToolSource } from '../../core/tool_vetting/tool_vetting.js';
import { isRecord, typeName } from '../../core/json.js';
import { JSON_LINES_FRAMING, CONTENT_LENGTH_FRAMING } from './_framing.js';
import type { ServerFactory } from './_types.js';

/** MCP 连接传输形态（HTTP 为主，stdio 次之，内存用于内嵌/测试）。 */
export const McpTransport = {
  HTTP: 'http',
  STDIO: 'stdio',
  IN_MEMORY: 'in_memory',
} as const;

export type McpTransportValue = (typeof McpTransport)[keyof typeof McpTransport];

const _TRANSPORT_VALUES: readonly string[] = Object.values(McpTransport);

// stdio 进程监督的保守缺省值（重启策略是数据字段，缺省取此处）
const DEFAULT_STDIO_RESTART_RETRIES = 2;
const DEFAULT_STDIO_RESTART_BACKOFF = 1.0;
const DEFAULT_STDIO_CIRCUIT_BREAK_THRESHOLD = 3;

/** stdio 进程重启策略（数据化声明；缺省 = 保守安全值）。 */
export class StdioRestartPolicy {
  readonly max_retries: number;
  readonly backoff: number;
  readonly circuit_break_threshold: number;

  constructor(init: {
    max_retries?: number;
    backoff?: number;
    circuit_break_threshold?: number;
  } = {}) {
    this.max_retries = init.max_retries ?? DEFAULT_STDIO_RESTART_RETRIES;
    this.backoff = init.backoff ?? DEFAULT_STDIO_RESTART_BACKOFF;
    this.circuit_break_threshold =
      init.circuit_break_threshold ?? DEFAULT_STDIO_CIRCUIT_BREAK_THRESHOLD;
    this.validate();
  }

  private validate(): void {
    if (this.max_retries < 0) {
      throw new Error(`重启尝试次数不能为负: ${this.max_retries}`);
    }
    if (this.backoff < 0) {
      throw new Error(`重启退避秒数不能为负: ${this.backoff}`);
    }
    if (this.circuit_break_threshold < 1) {
      throw new Error(`熔断阈值须 >= 1: ${this.circuit_break_threshold}`);
    }
  }

  to_dict(): Record<string, unknown> {
    return {
      max_retries: this.max_retries,
      backoff: this.backoff,
      circuit_break_threshold: this.circuit_break_threshold,
    };
  }

  static from_dict(data: unknown): StdioRestartPolicy {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `stdio 重启策略非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    return new StdioRestartPolicy({
      max_retries: (data['max_retries'] as number | undefined) ?? DEFAULT_STDIO_RESTART_RETRIES,
      backoff: Number(data['backoff'] ?? DEFAULT_STDIO_RESTART_BACKOFF),
      circuit_break_threshold:
        (data['circuit_break_threshold'] as number | undefined) ??
        DEFAULT_STDIO_CIRCUIT_BREAK_THRESHOLD,
    });
  }

  equals(other: StdioRestartPolicy): boolean {
    return (
      this.max_retries === other.max_retries &&
      this.backoff === other.backoff &&
      this.circuit_break_threshold === other.circuit_break_threshold
    );
  }
}

/** Python 可比较 Dataclass 的浅比较（序列化往返断言用）。 */
function _recordEquals(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every(
    (key) => JSON.stringify(a[key]) === JSON.stringify(b[key]),
  );
}

/**
 * MCP server 连接配置（数据形态，可持久化进集数据通道）。
 *
 * server_factory 为内存传输的 server 工厂（transport=in_memory 时必填），
 * 非序列化字段，持久化时忽略。repr 遮蔽 headers/env（凭据不进日志面）。
 */
export class McpServerConfig {
  readonly id: string;
  readonly transport: McpTransportValue;
  readonly url: string | null;
  readonly headers: Record<string, string> | null;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly env: Record<string, string> | null;
  readonly source: string;
  readonly signature: string | null;
  readonly server_factory: ServerFactory | null;
  readonly restart_policy: StdioRestartPolicy | null;
  readonly stdio_framing: string;

  constructor(init: {
    id: string;
    transport?: McpTransportValue;
    url?: string | null;
    headers?: Record<string, string> | null;
    command?: string | null;
    args?: readonly string[];
    env?: Record<string, string> | null;
    source?: string;
    signature?: string | null;
    server_factory?: ServerFactory | null;
    restart_policy?: StdioRestartPolicy | null;
    stdio_framing?: string;
  }) {
    this.id = init.id;
    this.transport = init.transport ?? McpTransport.HTTP;
    this.url = init.url ?? null;
    this.headers = init.headers ?? null;
    this.command = init.command ?? null;
    this.args = init.args ? [...init.args] : [];
    this.env = init.env ?? null;
    this.source = init.source ?? ToolSource.UNKNOWN;
    this.signature = init.signature ?? null;
    this.server_factory = init.server_factory ?? null;
    this.restart_policy = init.restart_policy ?? null;
    this.stdio_framing = init.stdio_framing ?? JSON_LINES_FRAMING;
    this._validate();
  }

  /** 构造校验（fail-closed）：http 传输的 url 仅接受 http/https 协议。 */
  private _validate(): void {
    if (this.transport !== McpTransport.HTTP) return;
    if (this.url === null || this.url === '') return;
    const scheme = this.url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1] ?? '';
    if (scheme !== 'http' && scheme !== 'https') {
      throw new GraphDefinitionError(
        `MCP 配置 url 必须使用 http/https 协议（非法 scheme=${JSON.stringify(scheme)}）`,
      );
    }
  }

  /** Python dataclass repr 口径（headers/env 凭据字段遮蔽不落文案）。 */
  toString(): string {
    const fields: string[] = [`id=${this.id}`, `transport=${this.transport}`];
    if (this.url !== null) fields.push(`url=${this.url}`);
    if (this.command !== null) fields.push(`command=${this.command}`);
    if (this.args.length > 0) fields.push(`args=${JSON.stringify(this.args)}`);
    fields.push(`source=${this.source}`);
    if (this.signature !== null) fields.push(`signature=${this.signature}`);
    if (this.restart_policy !== null) fields.push(`restart_policy=${JSON.stringify(this.restart_policy.to_dict())}`);
    if (this.stdio_framing !== JSON_LINES_FRAMING) {
      fields.push(`stdio_framing=${this.stdio_framing}`);
    }
    return `McpServerConfig(${fields.join(', ')})`;
  }

  /** 序列化（可持久化进集数据通道；redact_credentials=True = 凭据遮蔽）。 */
  to_dict(opts: { redact_credentials?: boolean } = {}): Record<string, unknown> {
    const redact = opts.redact_credentials ?? false;
    const mask = (map: Record<string, string>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(map).map(([k, v]) => [k, v ? '[REDACTED]' : v]),
      );
    const data: Record<string, unknown> = {
      id: this.id,
      transport: this.transport,
      source: this.source,
    };
    if (this.url !== null && this.url !== '') data['url'] = this.url;
    if (this.headers !== null) {
      data['headers'] = redact ? mask(this.headers) : { ...this.headers };
    }
    if (this.command !== null && this.command !== '') data['command'] = this.command;
    if (this.args.length > 0) data['args'] = [...this.args];
    if (this.env !== null) {
      data['env'] = redact ? mask(this.env) : { ...this.env };
    }
    if (this.signature !== null && this.signature !== '') data['signature'] = this.signature;
    if (this.restart_policy !== null) data['restart_policy'] = this.restart_policy.to_dict();
    if (this.stdio_framing !== JSON_LINES_FRAMING) data['stdio_framing'] = this.stdio_framing;
    return data;
  }

  /** Python 可比较 Dataclass 等值语义（序列化往返断言用）。 */
  equals(other: McpServerConfig): boolean {
    const keys = [
      'id',
      'transport',
      'url',
      'headers',
      'command',
      'args',
      'env',
      'source',
      'signature',
      'stdio_framing',
    ] as const;
    if (!_recordEquals(this.to_dict(), other.to_dict(), keys)) return false;
    const a = this.restart_policy;
    const b = other.restart_policy;
    if (a === null || b === null) return a === b;
    return a.equals(b);
  }

  /** 从数据形态还原（非法形态显式拒绝；未知键忽略，兼容增量演进）。 */
  static from_dict(data: unknown): McpServerConfig {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`MCP 配置非法: 期望 dict，收到 ${typeName(data)}`);
    }
    const serverId = data['id'];
    if (typeof serverId !== 'string' || serverId === '') {
      throw new GraphDefinitionError('MCP 配置缺 id（字符串）');
    }
    const rawTransport = data['transport'] ?? McpTransport.HTTP;
    if (typeof rawTransport !== 'string' || !_TRANSPORT_VALUES.includes(rawTransport)) {
      throw new GraphDefinitionError(`MCP 配置传输形态非法: ${String(rawTransport)}`);
    }
    const rawSource = data['source'] ?? ToolSource.UNKNOWN;
    if (typeof rawSource !== 'string' || !ToolSource.is_valid(rawSource)) {
      throw new GraphDefinitionError(`MCP 配置来源分类非法: ${String(rawSource)}`);
    }
    const headers = data['headers'];
    if (headers !== null && headers !== undefined && !isRecord(headers)) {
      throw new GraphDefinitionError('MCP 配置 headers 须为 dict（请求头映射）');
    }
    const env = data['env'];
    if (env !== null && env !== undefined && !isRecord(env)) {
      throw new GraphDefinitionError('MCP 配置 env 须为 dict（环境变量映射）');
    }
    const restartPolicy = data['restart_policy'];
    if (restartPolicy !== null && restartPolicy !== undefined && !isRecord(restartPolicy)) {
      throw new GraphDefinitionError('MCP 配置 restart_policy 须为 dict（重启策略声明）');
    }
    const stdioFraming = data['stdio_framing'] ?? JSON_LINES_FRAMING;
    if (stdioFraming !== CONTENT_LENGTH_FRAMING && stdioFraming !== JSON_LINES_FRAMING) {
      throw new GraphDefinitionError(
        `MCP 配置 stdio_framing 非法: ${String(stdioFraming)}` +
          '（须为 content_length 或 json_lines）',
      );
    }
    const argsRaw = data['args'];
    return new McpServerConfig({
      id: serverId,
      transport: rawTransport as McpTransportValue,
      url: (data['url'] as string | null | undefined) ?? null,
      headers: isRecord(headers) ? (headers as Record<string, string>) : null,
      command: (data['command'] as string | null | undefined) ?? null,
      args: Array.isArray(argsRaw)
        ? (argsRaw as unknown[]).filter((a): a is string => typeof a === 'string')
        : [],
      env: isRecord(env) ? (env as Record<string, string>) : null,
      source: rawSource,
      signature: (data['signature'] as string | null | undefined) ?? null,
      restart_policy:
        restartPolicy !== null && restartPolicy !== undefined
          ? StdioRestartPolicy.from_dict(restartPolicy)
          : null,
      stdio_framing: stdioFraming,
    });
  }
}
