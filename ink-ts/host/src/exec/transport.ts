/**
 * stdio JSON-RPC 子进程会话（原生机制件 client 的传输底座）。
 *
 * 行帧协议：stdin 写 JSON 行、stdout 读 JSON 行（exec/infer 共享），
 * stderr 为诊断通道（保留有界尾部供排障/断言）。请求按 id 关联响应
 * （进程单线程逐行处理，host 侧仍按 id 收口，天然支持顺序/交错请求）。
 * 进程死亡/IO 断流 = 挂起请求以 SessionLostError 拒绝（监督层按此判定
 * 走拉起路径）；close 幂等（kill + 拒绝全部挂起）。
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { RpcError, SessionLostError } from './_types.js';

/** 会话选项。 */
export interface NativeSpawnOptions {
  binary: string;
  args?: readonly string[];
  /** 附加环境（覆盖宿主进程环境同名键；缺省继承宿主环境）。 */
  env?: Record<string, string> | null;
  cwd?: string;
  /** stderr 诊断行回调（可选；另保留有界尾部）。 */
  onStderr?: (line: string) => void;
}

/** stderr 尾部保留上限（行）。 */
const STDERR_TAIL_MAX = 50;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** stdio JSON-RPC 子进程会话（自身不承载监督/重启——那是 session 层的事）。 */
export class StdioProcessSession {
  private readonly options: NativeSpawnOptions;
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  readonly stderrTail: string[] = [];
  exitCode: number | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly onStderr?: (line: string) => void;

  constructor(options: NativeSpawnOptions) {
    this.options = options;
    this.onStderr = options.onStderr;
  }

  /** 是否仍存活（可写请求）。 */
  get alive(): boolean {
    return !this.closed && this.child !== null && this.child.exitCode === null;
  }

  /** 拉起进程（幂等）；spawn 失败（二进制缺失等）以错误拒绝。 */
  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const env = { ...process.env, ...(this.options.env ?? {}) };
      const child = spawn(this.options.binary, [...(this.options.args ?? [])], {
        env,
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      if (child.stdin === null || child.stdout === null || child.stderr === null) {
        this.closed = true;
        reject(new SessionLostError('原生会话 stdio 管道不可用（spawn 形态异常）'));
        return;
      }
      child.stdin.setDefaultEncoding('utf8');
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let spawned = false;
      child.once('spawn', () => {
        spawned = true;
        resolve();
      });
      child.once('error', (error) => {
        this.closed = true;
        if (!spawned) {
          reject(
            new SessionLostError(
              `原生二进制启动失败（${this.options.binary}）: ${error.message}`,
            ),
          );
        } else {
          this._settleAll(new SessionLostError(`原生会话进程错误: ${error.message}`));
        }
      });
      child.stdout.on('data', (chunk: string) => this._onData(chunk));
      child.stderr.on('data', (chunk: string) => this._onStderrData(chunk));
      child.on('exit', (code) => {
        this.exitCode = code;
        this.closed = true;
        this._settleAll(
          new SessionLostError(`原生会话进程已退出（exit ${code ?? 'unknown'}）`),
        );
      });
    });
    return this.startPromise;
  }

  /** JSON-RPC 请求（result 直返；协议错误抛 RpcError；进程死抛 SessionLost）。 */
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.start();
    const id = String(this.nextId);
    this.nextId += 1;
    const child = this.child;
    if (child === null || !this.alive || child.stdin === null) {
      throw new SessionLostError('原生会话不可用（未拉起或已退出）');
    }
    const stdin = child.stdin;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    stdin.write(`${line}\n`, (error) => {
      if (error) {
        this._rejectPending(id, new SessionLostError(`请求写入失败: ${error.message}`));
      }
    });
    return await promise;
  }

  /** 幂等关停：kill 进程 + 拒绝全部挂起请求。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (child !== null && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // kill 失败（进程已消亡）忽略：走统一收口
      }
    }
    this._settleAll(new SessionLostError('会话已关停'));
  }

  private _onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === '') continue;
      this._handleLine(line);
    }
  }

  private _onStderrData(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      this.stderrTail.push(trimmed);
      if (this.stderrTail.length > STDERR_TAIL_MAX) this.stderrTail.shift();
      this.onStderr?.(trimmed);
    }
  }

  private _handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // 非 JSON 行（协议外噪音）忽略
    }
    const obj = msg as {
      id?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    const id = String(obj.id);
    const settle = this.pending.get(id);
    if (settle === undefined) return; // 未知 id（响应已超时被外部放弃）丢弃
    this.pending.delete(id);
    if (obj.error !== undefined) {
      const error = obj.error;
      const rawData = error.data;
      const reason =
        typeof rawData === 'object' && rawData !== null && !Array.isArray(rawData)
          ? ((rawData as { reason?: unknown }).reason as string | undefined) ?? null
          : null;
      settle.reject(
        new RpcError(
          error.code ?? -32000,
          error.message ?? 'JSON-RPC 错误',
          reason,
          typeof rawData === 'object' && rawData !== null && !Array.isArray(rawData)
            ? (rawData as Record<string, unknown>)
            : null,
        ),
      );
      return;
    }
    settle.resolve(obj.result);
  }

  private _rejectPending(id: string, error: unknown): void {
    const settle = this.pending.get(id);
    if (settle === undefined) return;
    this.pending.delete(id);
    settle.reject(error);
  }

  private _settleAll(error: unknown): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const pending of entries) pending.reject(error);
  }
}
