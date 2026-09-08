/**
 * stdio 进程会话的受监督句柄（崩溃探测 + 重启策略拉起）。
 *
 * 镜像 engine adapters/mcp SupervisedStdioSession 的语义，但承载的是
 * exec/infer 的 JSON-RPC 行帧（非 MCP SDK 会话）。与引擎监督同纪律：
 * 会话 = 进程（stdio 传输 = 进程生命周期绑定，协议断流即进程死了）；
 * 调用失败 = 崩溃 → 按策略拉起 → **本次调用不自动重试**（OS 副作用可能
 * 已部分执行，重试有非幂等风险，fail-safe 诚实失败）；连续「重试耗尽」
 * 计分到阈值 = 熔断打开（fail-closed 拒绝调用直到重连）。
 *
 * 业务错误（server 已受理返回 JSON-RPC error，含守门拒绝）原样穿透，
 * 不误判为进程崩溃。
 */

import { ExecRefusedError, RpcError, SessionLostError } from './_types.js';
import type { RestartPolicy } from './_types.js';
import { DEFAULT_RESTART_POLICY } from './_types.js';
import { StdioProcessSession } from './transport.js';
import type { NativeSpawnOptions } from './transport.js';

/** 简单异步互斥（进程粒度串行：监督路径需要单一所有者，防并发双重拉起）。 */
class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 会话打开器（默认 spawn；测试注入假打开器/计数）。 */
export type SessionOpener = (options: NativeSpawnOptions) => Promise<StdioProcessSession>;

const defaultOpener: SessionOpener = async (options) => {
  const session = new StdioProcessSession(options);
  await session.start();
  return session;
};

/** 受监督原生会话（exec/infer 共用样板）。 */
export class SupervisedNativeSession {
  readonly options: NativeSpawnOptions;
  readonly policy: RestartPolicy;
  private session: StdioProcessSession | null = null;
  private circuitOpen = false;
  private consecutiveFailures = 0;
  private readonly opener: SessionOpener;
  private readonly lock = new AsyncLock();

  constructor(
    options: NativeSpawnOptions,
    policy: Partial<RestartPolicy> = {},
    opener: SessionOpener | null = null,
  ) {
    this.options = options;
    this.policy = { ...DEFAULT_RESTART_POLICY, ...policy };
    this.opener = opener ?? defaultOpener;
  }

  /** 熔断状态（熔断打开 = 不再拉起 + 调用 fail-closed）。 */
  get isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /** 连续失败计数（「重试耗尽」次数；拉起成功即清零）。 */
  get failures(): number {
    return this.consecutiveFailures;
  }

  private async openFresh(): Promise<StdioProcessSession> {
    return await this.opener(this.options);
  }

  private async ensureOpen(): Promise<StdioProcessSession> {
    if (this.circuitOpen) {
      throw new ExecRefusedError(
        `原生会话 ${this.options.binary} 熔断已打开（连续拉起失败），回调被拒——请重连/检查进程环境`,
      );
    }
    if (this.session === null) {
      this.session = await this.openFresh();
      this.consecutiveFailures = 0;
    }
    return this.session;
  }

  private async teardown(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session !== null) {
      try {
        await session.close();
      } catch {
        // 会话清理失败是清理噪音：不影响崩溃路径
      }
    }
  }

  /** 崩溃拉起：按策略尝试有限次，重试耗尽上报并计数/熔断。 */
  private async respawn(cause: unknown): Promise<StdioProcessSession> {
    const attempts = this.policy.max_retries;
    let lastError: unknown = cause;
    await this.teardown();
    for (let n = 0; n < attempts; n += 1) {
      if (this.policy.backoff > 0) {
        await sleep(Math.round(this.policy.backoff * 1000));
      }
      try {
        const session = await this.openFresh();
        this.session = session;
        this.consecutiveFailures = 0;
        return session;
      } catch (exc) {
        lastError = exc;
      }
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.policy.circuit_break_threshold) {
      this.circuitOpen = true;
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new SessionLostError(
      `原生会话 ${this.options.binary} 崩溃且重启失败（${attempts} 次尝试，熔断=${this.circuitOpen}）: ${detail}`,
    );
  }

  /** 会话调用 + 崩溃拉起（本次调用不重试——防非幂等副作用）。 */
  private async invoke<T>(op: (session: StdioProcessSession) => Promise<T>): Promise<T> {
    return await this.lock.run<T>(async () => {
      let session: StdioProcessSession;
      try {
        session = await this.ensureOpen();
      } catch (exc) {
        if (this.circuitOpen) throw exc;
        await this.respawn(exc);
        throw new SessionLostError(
          `原生会话 ${this.options.binary} 首次拉起失败（已按策略拉起，本次调用未重试）`,
        );
      }
      try {
        return await op(session);
      } catch (exc) {
        if (exc instanceof RpcError || exc instanceof ExecRefusedError) throw exc;
        await this.respawn(exc);
        throw new SessionLostError(
          `原生会话 ${this.options.binary} 在调用期间崩溃（已按策略拉起，本次调用未重试——防非幂等副作用）`,
        );
      }
    });
  }

  /** JSON-RPC 请求（受监督；业务错误原样穿透）。 */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.invoke<unknown>(async (session) => await session.request(method, params));
  }

  /** 存活探测：协议级 ping；探测失败 = 崩溃 → 拉起（拉起成功 true）。 */
  async healthCheck(): Promise<boolean> {
    if (this.circuitOpen) return false;
    return await this.lock.run<boolean>(async () => {
      try {
        const session = await this.ensureOpen();
        await session.request('ping', {});
        return true;
      } catch (exc) {
        if (exc instanceof RpcError) return true; // ping 业务失败 = 进程活着
        try {
          await this.respawn(exc);
          return true;
        } catch {
          return false;
        }
      }
    });
  }

  /** 释放句柄（切断监督：后续访问按 ensureOpen 重新拉起）。 */
  async close(): Promise<void> {
    await this.lock.run<void>(async () => {
      this.circuitOpen = false;
      this.consecutiveFailures = 0;
      await this.teardown();
    });
  }
}
