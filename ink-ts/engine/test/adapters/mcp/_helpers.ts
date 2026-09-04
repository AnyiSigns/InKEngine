/**
 * MCP 适配器测试共享桩（镜像 Python 测试的 _FakeSession/_RejectVetting/
 * _AcceptVetting 形态），及真实 stdio 用例共享的 node echo server 装配。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  JSON_LINES_FRAMING,
  McpServerConfig,
  McpTransport,
  StdioRestartPolicy,
  create_node_fs_seam,
  type McpSessionHandle,
  type McpToolRecord,
} from '../../../src/adapters/mcp/index.js';
import {
  ShadowRunResult,
  ToolSource,
  ToolVetting,
  VettingResult,
  VettingVerdict,
  type ShadowExecutor,
} from '../../../src/core/tool_vetting/tool_vetting.js';

/** 测试桩会话：实现 list_tools/call_tool/aclose，记录调用便于断言。 */
export class FakeSession implements McpSessionHandle {
  _tools: McpToolRecord[];
  calls: Array<[string, Record<string, unknown>]>;
  closed = false;

  constructor(tools: McpToolRecord[], calls?: Array<[string, Record<string, unknown>]>) {
    this._tools = tools;
    this.calls = calls ?? [];
  }

  async list_tools(): Promise<McpToolRecord[]> {
    return [...this._tools];
  }

  async call_tool(name: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push([name, args]);
    return `result-of-${name}`;
  }

  async aclose(): Promise<void> {
    this.closed = true;
  }
}

/** 假 vetting：按工具名集合拒绝，其余 verified（验证过滤语义）。 */
export class RejectVetting {
  private readonly _reject_names: Set<string>;

  constructor(reject_names: string[] = []) {
    this._reject_names = new Set(reject_names);
  }

  async vet(manifest: { name: string }): Promise<VettingResult> {
    const ok = !this._reject_names.has(manifest.name);
    return new VettingResult({
      ok,
      verdict: ok ? VettingVerdict.VERIFIED : VettingVerdict.REJECTED,
      reason: ok ? '' : '被测试桩拒绝',
    });
  }

  async shadow_run(
    _executor: ShadowExecutor,
    _args: Record<string, unknown>,
    _opts: { workdir: string },
  ): Promise<ShadowRunResult> {
    return new ShadowRunResult({ ok: true });
  }
}

/** 假 vetting：全量 verified（观察模式接线测试用；shadow_run 继承真实实现）。 */
export class AcceptVetting extends ToolVetting {
  constructor() {
    super({ fs: create_node_fs_seam() });
  }

  async vet(_manifest: unknown): Promise<VettingResult> {
    return new VettingResult({ ok: true, verdict: VettingVerdict.VERIFIED });
  }
}

/** 假 vetting：恒 REVIEW（静态审查命中 = 需人工确认，不自动放行）。 */
export class ReviewVetting {
  async vet(_manifest: unknown): Promise<VettingResult> {
    return new VettingResult({
      ok: true,
      verdict: VettingVerdict.REVIEW,
      reason: '静态审查命中',
    });
  }

  async shadow_run(
    _executor: ShadowExecutor,
    _args: Record<string, unknown>,
    _opts: { workdir: string },
  ): Promise<ShadowRunResult> {
    return new ShadowRunResult({ ok: true });
  }
}

/** 构造 MCP 工具条目（dict 形态；schema 字段形态由 snake_case 决定）。 */
export function mcp_tool(
  name: string,
  schema?: Record<string, unknown>,
  snake_case = false,
): McpToolRecord {
  const parameters =
    schema ?? { type: 'object', properties: { q: { type: 'string' } } };
  const out: McpToolRecord = {
    name,
    description: `${name} 工具描述`,
  };
  out[snake_case ? 'input_schema' : 'inputSchema'] = parameters;
  return out;
}

export { ToolSource, VettingVerdict };

/** 内存假子进程的三条管道（fake spawn seam 的承载）。 */
export function memory_child_streams(): {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const tmp_dirs: string[] = [];

/** 建唯一临时目录并登记到共享清单（测试文件经 cleanup_tmp_dirs 统一清理）。 */
export function tmp_dir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-'));
  tmp_dirs.push(dir);
  return dir;
}

/** 清理登记过的临时目录（测试文件 afterEach 调用）。 */
export function cleanup_tmp_dirs(): void {
  for (const dir of tmp_dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 最小 MCP stdio server（node 单文件）：echo_text + ping + 故障注入。 */
export const ECHO_SERVER = [
  "const json = JSON.stringify;",
  "function send(payload) {",
  "  const body = Buffer.from(json(payload), 'utf-8');",
  "  if (process.env.ECHO_FRAMING === 'content_length') {",
  "    process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');",
  "    process.stdout.write(body);",
  "  } else {",
  "    process.stdout.write(body);",
  "    process.stdout.write('\\n');",
  "  }",
  "}",
  "function reply(id, result, error) {",
  "  send(error ? {jsonrpc:'2.0', id, error} : {jsonrpc:'2.0', id, result});",
  "}",
  "if (process.env.ECHO_DIE_ON_START === '1') process.exit(1);",
  "if (process.env.ECHO_STDERR === '1') {",
  "  process.stderr.write('{\"level\":\"info\",\"event\":\"rpc\",\"method\":\"tools/list\",\"id\":41,\"duration_ms\":1,\"ok\":true}\\n');",
  "  process.stderr.write('{\"level\":\"error\",\"event\":\"rpc\",\"method\":\"tools/call\",\"id\":42,\"duration_ms\":1,\"ok\":false}\\n');",
  "}",
  "const crashFile = process.env.ECHO_CRASH_FILE || '';",
  "function handle(msg) {",
  "  const method = msg.method;",
  "  if (msg.id === undefined) return;",
  "  if (method === 'initialize') {",
  "    reply(msg.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: {name:'echo', version:'1'} });",
  "    return;",
  "  }",
  "  if (method === 'tools/list') {",
  "    reply(msg.id, { tools: [{ name: 'echo_text', description: 'echo a text',",
  "      inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });",
  "    return;",
  "  }",
  "  if (method === 'tools/call') {",
  "    if (crashFile) {",
  "      const fs2 = require('fs');",
  "      if (!fs2.existsSync(crashFile)) {",
  "        fs2.writeFileSync(crashFile, 'crashed');",
  "        process.stderr.write('{\"level\":\"info\",\"msg\":\"dying\"}\\n');",
  "        process.exit(1);",
  "      }",
  "    }",
  "    const params = msg.params || {};",
  "    const name = params.name;",
  "    const args = params.arguments || {};",
  "    if (name === 'echo_text') {",
  "      reply(msg.id, { content: [{ type: 'text', text: String(args.text || '') }], isError: false });",
  "    } else if (name === 'reject') {",
  "      reply(msg.id, null, { code: -32602, message: 'invalid params' });",
  "    } else if (name === 'fail') {",
  "      reply(msg.id, { content: [{ type: 'text', text: 'boom' }], isError: true });",
  "    } else {",
  "      reply(msg.id, null, { code: -32601, message: 'method not found: ' + name });",
  "    }",
  "    return;",
  "  }",
  "  if (method === 'ping') { reply(msg.id, {}); return; }",
  "  reply(msg.id, null, { code: -32601, message: 'method not found: ' + method });",
  "}",
  "let buf = '';",
  "function tryParse() {",
  "  for (;;) {",
  "    if (buf.startsWith('Content-Length:')) {",
  "      const idx = buf.indexOf('\\r\\n\\r\\n');",
  "      if (idx < 0) return;",
  "      const len = parseInt(buf.slice(15, idx), 10);",
  "      const total = idx + 4 + len;",
  "      if (buf.length < total) return;",
  "      const body = buf.slice(idx + 4, total);",
  "      buf = buf.slice(total);",
  "      handle(JSON.parse(body));",
  "      continue;",
  "    }",
  "    const nl = buf.indexOf('\\n');",
  "    if (nl < 0) return;",
  "    const line = buf.slice(0, nl);",
  "    buf = buf.slice(nl + 1);",
  "    if (line.trim()) handle(JSON.parse(line));",
  "  }",
  "}",
  "process.stdin.on('data', (chunk) => { buf += chunk; tryParse(); });",
].join('\n');

/** echo server 的 stdio 连接配置（env 装载故障注入开关）。 */
export function echo_config(opts: {
  framing?: string;
  crash_file?: string;
  die_on_start?: boolean;
  stderr?: boolean;
  restart_policy?: StdioRestartPolicy | null;
} = {}): McpServerConfig {
  const env: Record<string, string> = {};
  if (opts.framing !== undefined) env['ECHO_FRAMING'] = opts.framing;
  if (opts.crash_file !== undefined) env['ECHO_CRASH_FILE'] = opts.crash_file;
  if (opts.die_on_start === true) env['ECHO_DIE_ON_START'] = '1';
  if (opts.stderr === true) env['ECHO_STDERR'] = '1';
  return new McpServerConfig({
    id: 'echo',
    transport: McpTransport.STDIO,
    command: process.execPath,
    args: ['-e', ECHO_SERVER],
    env,
    source: 'market',
    stdio_framing: opts.framing ?? JSON_LINES_FRAMING,
    restart_policy: opts.restart_policy ?? null,
  });
}
