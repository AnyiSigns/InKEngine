/**
 * stdio 进程会话的受监督句柄：崩溃探测 + 按重启策略拉起（镜像 Python
 * mcp_client.py 的 _SupervisedStdioSession）。
 *
 * 在既有 spawn/退出清理/stderr 桥之上只补监督，不重写底层：本句柄持有
 * 当前 SdkSession，调用失败视为进程崩溃（stdio 传输 = 进程生命周期绑定，
 * 协议失败即进程死了），走「拉起 → 回到服务」路径——拉起成功后不透传
 * 重试原操作：失败的工具调用可能已在崩溃前被部分执行，重试有非幂等
 * 副作用风险（fail-safe：诚实失败，下个调用命中新会话）。连接断流类
 * （请求未达 server）拉起成功后重试一次原操作（stdio 仅承载确定性纯函数
 * 工具，重试无副作用风险）。
 *
 * 失败路径（重试耗尽 → 熔断打开 → 错误上报）：
 * - 拉起尝试有界（max_retries，间隔 backoff 秒）；
 * - 一次「重试耗尽」事件计 1 分，连续到达 circuit_break_threshold =
 *   熔断打开（fail-closed 直接拒绝调用直到重连/换会话）；
 * - 拉起成功清零连续失败分（熔断只凭健康度判定）。
 *
 * 业务错误（server 已受理返回 is_error/JSON-RPC error）与任务取消
 * （TaskCancelled，镜像 CancelledError）原样穿透，不误判为进程崩溃。
 */
import { McpToolImportError, TaskCancelled, is_business_error } from './_errors.js';
import { is_connection_lost } from './_errors.js';
import { StdioRestartPolicy } from './config.js';
import { SdkSession, McpSessionHandle } from './session.js';
import type { McpToolRecord } from './_types.js';
import type { McpServerConfig } from './config.js';

/** 会话打开器（默认 = SdkSession.open；测试注入假打开器/计数）。 */
export type SessionOpener = (config: McpServerConfig) => Promise<McpSessionHandle>;

/** 简单异步互斥（镜像 asyncio.Lock 的调用串行化）。 */
export class AsyncLock {
  private _tail: Promise<void> = Promise.resolve();

  async acquire_run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._tail;
    let release!: () => void;
    this._tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const _sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** stdio 进程会话的受监督句柄（崩溃探测 + 重启策略拉起）。 */
export class SupervisedStdioSession extends McpSessionHandle {
  readonly _config: McpServerConfig;
  readonly _policy: StdioRestartPolicy;
  _session: McpSessionHandle | null;
  _circuit_open = false;
  _consecutive_failures = 0;
  private readonly _opener: SessionOpener;
  private readonly _lock = new AsyncLock();

  constructor(
    config: McpServerConfig,
    opts: {
      initial?: McpSessionHandle | null;
      opener?: SessionOpener;
    } = {},
  ) {
    super();
    this._config = config;
    this._policy = config.restart_policy ?? new StdioRestartPolicy();
    this._opener =
      opts.opener ??
      (async (cfg: McpServerConfig): Promise<McpSessionHandle> => {
        return await SdkSession.open(cfg);
      });
    this._session = opts.initial ?? null;
  }

  /** 熔断状态（熔断打开 = 不再拉起 + 调用 fail-closed）。 */
  get circuit_open(): boolean {
    return this._circuit_open;
  }

  /** 连续失败计数（「重试耗尽」次数；拉起成功即清零）。 */
  get consecutive_failures(): number {
    return this._consecutive_failures;
  }

  private async _open_fresh(): Promise<McpSessionHandle> {
    return await this._opener(this._config);
  }

  private async _ensure_open(): Promise<McpSessionHandle> {
    if (this._circuit_open) {
      throw new McpToolImportError(
        `MCP server ${this._config.id} 的 stdio 进程熔断已打开` +
          '（连续拉起失败），回调被拒——请重连/检查进程环境',
      );
    }
    if (this._session === null) {
      this._session = await this._open_fresh();
      // 建立成功 = 进程可用：连续失败分清零（熔断只凭健康度判定）
      this._consecutive_failures = 0;
    }
    return this._session;
  }

  /** 关闭当前会话句柄（失败只记日志：清理不掩盖崩溃路径）。 */
  private async _teardown(): Promise<void> {
    const session = this._session;
    this._session = null;
    if (session !== null) {
      try {
        await session.aclose();
      } catch {
        // 会话清理失败是清理噪音：不影响崩溃路径
      }
    }
  }

  /** 崩溃拉起：按策略尝试有限次，重试耗尽上报并计数/熔断。 */
  private async _respawn(cause: unknown): Promise<McpSessionHandle> {
    const attempts = this._policy.max_retries;
    let lastError: unknown = cause;
    // 崩溃会话先清除（无论是否重启：僵死句柄不得继续承接调用）
    await this._teardown();
    for (let n = 0; n < attempts; n += 1) {
      if (this._policy.backoff > 0) {
        await _sleep(Math.round(this._policy.backoff * 1000));
      }
      try {
        const session = await this._open_fresh();
        this._session = session;
        this._consecutive_failures = 0;
        return session;
      } catch (exc) {
        lastError = exc;
        // 拉起失败：继续下一轮尝试
      }
    }
    this._consecutive_failures += 1;
    if (this._consecutive_failures >= this._policy.circuit_break_threshold) {
      this._circuit_open = true;
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new McpToolImportError(
      `MCP server ${this._config.id} 的 stdio 进程崩溃且重启失败` +
        `（${attempts} 次尝试，熔断=${this._circuit_open}）: ${detail}`,
    );
  }

  /**
   * 会话调用 + 崩溃拉起。按进程粒度串行（会话即进程：监督路径需要单一
   * 所有者，并发崩溃会双重拉起且失败互踩）。会话建立失败（进程秒崩）与
   * 调用期失败同走拉起路径——两者都是「进程不可用」。
   */
  private async _invoke<T>(
    op: (session: McpSessionHandle) => Promise<T>,
    op_name: string,
  ): Promise<T> {
    let respawned = false;
    return await this._lock.acquire_run<T>(async () => {
      try {
        const session = await this._ensure_open();
        try {
          return await op(session);
        } catch (exc) {
          if (exc instanceof TaskCancelled) throw exc;
          if (is_business_error(exc)) throw exc; // 业务失败直接透传
          respawned = true;
          const connection_lost = is_connection_lost(exc);
          await this._respawn(exc);
          if (connection_lost && this._session !== null) {
            try {
              return await op(this._session);
            } catch (exc2) {
              if (exc2 instanceof TaskCancelled) throw exc2;
              throw new McpToolImportError(
                `MCP server ${this._config.id} 的 stdio 进程在 ${op_name} ` +
                  `期间崩溃（已按策略拉起并重试一次仍失败）: ${_detail(exc2)}`,
              );
            }
          }
          throw new McpToolImportError(
            `MCP server ${this._config.id} 的 stdio 进程在 ${op_name} 期间崩溃` +
              `（已按策略拉起，本次调用未重试——防非幂等副作用）: ${_detail(exc)}`,
          );
        }
      } catch (exc) {
        if (exc instanceof McpToolImportError) {
          if (respawned || this._circuit_open) throw exc; // 拉起路径已收敛
          // 会话建立失败（进程启动即崩/不可用）：按策略拉起 + 计数
          await this._respawn(exc);
          throw new McpToolImportError(
            `MCP server ${this._config.id} 的 stdio 会话在 ${op_name} 期间失效` +
              `（已按策略拉起，本次调用未重试）: ${_detail(exc)}`,
          );
        }
        if (exc instanceof TaskCancelled) throw exc; // 外层取消原样穿透
        if (is_business_error(exc)) throw exc; // 业务失败不被兜底误判
        // 会话建立失败（首次拉起/进程秒崩）→ 走重试耗尽路径
        await this._respawn(exc);
        throw new McpToolImportError(
          `MCP server ${this._config.id} 的 stdio 会话在 ${op_name} 期间失效` +
            `（已按策略拉起，本次调用未重试）: ${_detail(exc)}`,
        );
      }
    });
  }

  async list_tools(): Promise<McpToolRecord[]> {
    return await this._invoke<McpToolRecord[]>(
      async (session) => await session.list_tools(),
      'list_tools',
    );
  }

  async call_tool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return await this._invoke<string>(
      async (session) => await session.call_tool(name, args),
      'call_tool',
    );
  }

  /** 存活探测：协议级 ping；探测失败 = 崩溃 → 拉起（拉起成功 True）。 */
  async health_check(): Promise<boolean> {
    if (this._circuit_open) return false;
    return await this._lock.acquire_run<boolean>(async () => {
      try {
        const session = await this._ensure_open();
        await this._probe(session);
        return true;
      } catch (exc) {
        if (exc instanceof TaskCancelled) throw exc;
        try {
          await this._respawn(exc);
          return true;
        } catch {
          return false;
        }
      }
    });
  }

  /** 协议探测：ping 能力判定（存活与否 = 进程可服务性）。句柄均带 ping
   *  （SdkSession 及其下各传输实现）；缺失视为不可探测即健康通过（无历史
   *  测试桩的 send_ping 双形态，语义已收紧为单一 ping 面）。 */
  private async _probe(session: McpSessionHandle): Promise<void> {
    const ping = (session as { ping?: () => Promise<void> }).ping;
    if (ping === undefined) return;
    await ping.call(session);
  }

  /** 释放句柄（切断监督：后续访问按 ensure_open 重新拉起）。 */
  async aclose(): Promise<void> {
    await this._lock.acquire_run<void>(async () => {
      this._circuit_open = false;
      this._consecutive_failures = 0;
      await this._teardown();
    });
  }
}

function _detail(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
