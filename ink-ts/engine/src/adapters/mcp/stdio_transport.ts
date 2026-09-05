// gate: 超限(367 行) - stdio 传输单段（子进程生命周期+双工 framing+重启恢复），拆文件即破状态机
/**
 * 自写 MCP stdio 客户端（镜像 Python mcp_client.py 的 _ThreadedMcpTransport）。
 *
 * TS 侧无「每次 op 新建 event loop」的嵌入问题（Node 单进程单事件循环 =
 * 引擎生命周期），自写传输因此无需线程私有 loop：直接以 node:child_process
 * spawn + 读侧自适应分帧承载。协议面与 Python 对齐：
 * - initialize 握手在 open 期完成，之后 tools/list、tools/call 即用；
 * - 请求/响应按 id 配对（挂起表经 RpcChannel）；server→client 请求应答
 *   ping/roots/list（未知方法回 -32601）；通知（progress 等）忽略；
 * - 读侧自适应两种 stdio 分帧（Content-Length / JSON Lines），写侧按配置
 *   显式启用（本环境缺省 json_lines），server 以 JSON Lines 响应时写侧
 *   同步切换（容错未显式配置的 server）；
 * - 帧大小超可信上界（MAX_STDIO_FRAME_BYTES）fail-closed 断开（不按声明
 *   值分配缓冲，防恶意超大 Content-Length）；
 * - 进程 stderr（结构化日志通道）逐行转发进宿主注入的 on_exec_line 通道。
 *
 * spawn seam 可注入：单元测试以内存流对冒充子进程，零真实进程确定性
 * 验证协议（分帧/分发/断流收敛）。
 */
import { spawn } from 'node:child_process';
import { McpConnectionLost, McpToolImportError, RpcTimeout } from './_errors.js';
import {
  CALL_TIMEOUT,
  CONNECT_TIMEOUT,
  JSON_LINES_FRAMING,
  MAX_STDIO_FRAME_BYTES,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
  encode_mcp_frame,
  exec_line_is_error,
  read_messages,
} from './_framing.js';
import type { McpServerConfig } from './config.js';
import { RpcChannel } from './_rpc_channel.js';
import type {
  McpCallResult,
  McpToolRecord,
  RawMcpSession,
  SpawnedMcpProcess,
  SpawnSeam,
} from './_types.js';
import { AsyncQueue } from './_types.js';

const _sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 默认 spawn seam（node:child_process；Windows 隐藏控制台窗口）。 */
export function create_node_spawn_seam(): SpawnSeam {
  return (command, args, opts) => {
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 子进程环境：缺省继承宿主环境；显式 env 与宿主环境合并（repr 遮蔽
      // 的凭据仍会以明文进入子进程——子进程本就需要它们才能工作）
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: opts.windows_hide ?? true,
      shell: false,
    });
    let settled = false;
    // 吞 Premature close/EPIPE 等流级错误事件（异步迭代会自行收敛断流；
    // 无消费者的窗口期 destroy 不再产生 unhandled 'error'）
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    const exit = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
        child.once('close', (code, signal) => {
          if (settled) return;
          settled = true;
          resolve({ code, signal });
        });
      },
    );
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: () => {
        child.kill('SIGTERM');
      },
      destroy_io: () => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      },
      exit,
    };
  };
}

/** stdio 传输（RawMcpSession 形态；open 期完成握手）。 */
export class StdioMcpTransport implements RawMcpSession {
  readonly _config: McpServerConfig;
  _channel: RpcChannel | null = null;
  _child: SpawnedMcpProcess | null = null;
  _write_framing: string;
  _pending_frames: AsyncQueue<Buffer> | null = null;
  _tasks: Promise<unknown>[] = [];
  _closed = false;
  _startup_error: unknown = null;
  _server_info: Record<string, unknown> | null = null;
  private readonly _spawn_seam: SpawnSeam;
  private readonly _on_exec_line: ((level: 'error' | 'info', line: string) => void) | null;
  private _stderr_buffer = '';

  constructor(
    config: McpServerConfig,
    opts: {
      spawn_seam?: SpawnSeam;
      on_exec_line?: (level: 'error' | 'info', line: string) => void;
    } = {},
  ) {
    this._config = config;
    this._write_framing = config.stdio_framing;
    this._spawn_seam = opts.spawn_seam ?? create_node_spawn_seam();
    this._on_exec_line = opts.on_exec_line ?? null;
  }

  /** 启动子进程并完成 initialize 握手（失败统一收敛为 McpToolImportError）。 */
  async start(): Promise<void> {
    try {
      await this._bootstrap();
    } catch (exc) {
      await this._cleanup_after_failed_start();
      throw exc;
    }
  }

  private async _bootstrap(): Promise<void> {
    const config = this._config;
    const child = this._spawn_seam(
      config.command as string,
      [...config.args],
      { env: config.env, windows_hide: true },
    );
    this._child = child;
    const queue = new AsyncQueue<Buffer>();
    this._pending_frames = queue;
    const channel = new RpcChannel(
      {
        read: read_messages(child.stdout, config.id, {
          on_switch_to_json_lines: () => {
            if (this._write_framing !== JSON_LINES_FRAMING) {
              this._write_framing = JSON_LINES_FRAMING;
            }
          },
        }),
        write: async (message) => {
          queue.push(
            encode_mcp_frame(
              message as unknown as Record<string, unknown>,
              this._write_framing,
            ),
          );
        },
      },
      config.id,
    );
    this._channel = channel;
    channel.start();
    this._tasks = [this._run_writer(child), this._run_stderr(child), channel.join()];
    // 进程退出（含 spawn 失败 reject）→ 断流收敛（挂起表全部失败）
    child.exit.then(
      () => undefined,
      (exc: unknown) => {
        this._startup_error = exc;
        channel.close();
        this._pending_frames?.close();
      },
    );
    let init_error: unknown = null;
    try {
      const result = await channel.request(
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
      channel.notify('notifications/initialized', {});
    } catch (exc) {
      init_error = exc;
    }
    if (this._startup_error !== null && this._startup_error !== undefined) {
      const error = this._startup_error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpToolImportError(
        `MCP server ${config.id} stdio 连接失败: ${detail}`,
      );
    }
    if (init_error !== null) {
      if (init_error instanceof McpToolImportError) throw init_error;
      if (init_error instanceof RpcTimeout) {
        throw new McpToolImportError(
          `MCP server ${config.id} stdio 连接失败: 连接超时（${CONNECT_TIMEOUT} 秒）`,
        );
      }
      const detail =
        init_error instanceof Error ? init_error.message : String(init_error);
      throw new McpToolImportError(
        `MCP server ${config.id} stdio 连接失败: ${detail}`,
      );
    }
  }

  private async _run_writer(child: SpawnedMcpProcess): Promise<void> {
    // 吞 EPIPE/Premature close 等写侧噪音：断流由读侧 EOF / 退出收敛
    child.stdin.on('error', () => undefined);
    const queue = this._pending_frames;
    if (queue === null) return;
    for (;;) {
      const frame = await queue.next();
      if (frame === undefined) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          child.stdin.write(frame, finish);
        } catch {
          finish();
        }
        // 进程退出即视为写侧结束（不空等未达的回调；崩溃路径不挂写循环）
        child.exit.then(finish, finish);
      });
    }
  }

  private async _run_stderr(child: SpawnedMcpProcess): Promise<void> {
    try {
      for await (const chunk of child.stderr) {
        this._stderr_buffer += chunk.toString('utf-8');
        let index: number;
        while ((index = this._stderr_buffer.indexOf('\n')) >= 0) {
          const line = this._stderr_buffer.slice(0, index);
          this._stderr_buffer = this._stderr_buffer.slice(index + 1);
          const text = line.replace(/\r$/, '').trim();
          if (text === '') continue;
          // 执行件把 stderr 当结构化日志通道；无注入通道时也消费（防管道
          // 缓冲写满阻塞子进程），行数据丢弃
          if (this._on_exec_line === null) continue;
          const level = exec_line_is_error(text) ? 'error' : 'info';
          this._on_exec_line(level, text);
        }
        // 无行终止的残段缓冲有上界：进程失控（超大单行/乱码洪泛）不得无限
        // 累积内存，超限按读侧帧超限同口径 fail-closed 断开
        if (this._stderr_buffer.length > MAX_STDIO_FRAME_BYTES) {
          throw new McpConnectionLost(
            `MCP server ${this._config.id} stderr 无行终止输出超 ` +
              `${MAX_STDIO_FRAME_BYTES} 字节（进程失控），连接已断开`,
          );
        }
      }
    } catch {
      // stderr 通道异常/缓冲超限：进程视为失控 fail-closed 断开（与读侧
      // 帧超限断开同语义）。清理噪音不重抛——task 已无悬挂值可拒绝，断流
      // 收敛交给读侧（挂起表以连接断流失败）
      try {
        this._channel?.close();
      } catch {
        // 关闭失败由读侧断流收敛
      }
      try {
        child.kill();
      } catch {
        // 进程已退出时的 kill 噪音忽略
      }
    }
  }

  // ── 能力面（协议方法）──────────────────────────────────────────────

  private async _request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this._channel === null) {
      throw new McpConnectionLost(`MCP server ${this._config.id} 连接已关闭`);
    }
    return await this._channel.request(method, params, timeoutMs);
  }

  async list_tools(): Promise<McpToolRecord[]> {
    const result = await this._request('tools/list', {}, Math.round(CALL_TIMEOUT * 1000));
    if (typeof result !== 'object' || result === null) return [];
    const tools = (result as Record<string, unknown>)['tools'];
    return Array.isArray(tools) ? (tools as McpToolRecord[]) : [];
  }

  async call_tool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const result = await this._request(
      'tools/call',
      { name, arguments: arguments_ ?? {} },
      Math.round(CALL_TIMEOUT * 1000),
    );
    if (typeof result !== 'object' || result === null) {
      return {
        content: [{ type: 'text', text: String(result) }],
        isError: false,
      };
    }
    return result as McpCallResult;
  }

  async ping(): Promise<void> {
    await this._request('ping', {}, Math.round(CALL_TIMEOUT * 1000));
  }

  /** 确定性关闭：终止子进程 + 关闭通道/写队 + 收尾各循环。 */
  async aclose(): Promise<void> {
    if (this._closed && this._tasks.length === 0) return;
    this._closed = true;
    const child = this._child;
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 终止失败继续清理（kill 非存在进程等）
      }
      // 进程退出即关闭管道（stdout EOF 结束读侧；不主动 destroy 流——
      // 避免 Premature close 噪音），超时后再补一次 kill
      const exited = await Promise.race([
        child.exit.then(() => true).catch(() => true),
        _sleep(3000),
      ]);
      if (!exited) {
        try {
          child.kill();
        } catch {
          // 清理噪音
        }
        await child.exit.catch(() => null);
      }
    }
    this._channel?.close();
    this._pending_frames?.close();
    await this._settle_tasks();
  }

  private async _cleanup_after_failed_start(): Promise<void> {
    this._closed = true;
    const child = this._child;
    if (child !== null) {
      try {
        child.kill();
      } catch {
        // 清理噪音
      }
      await child.exit.catch(() => null);
    }
    this._channel?.close();
    this._pending_frames?.close();
    await this._settle_tasks();
  }

  /** 收尾各循环（有界等待：清理不因残留句柄无限挂起，fail-closed）。 */
  private async _settle_tasks(): Promise<void> {
    const tasks = this._tasks;
    this._tasks = [];
    if (tasks.length === 0) return;
    await Promise.race([
      Promise.allSettled(tasks),
      _sleep(1500),
    ]);
  }
}
