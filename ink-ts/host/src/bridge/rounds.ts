/**
 * rounds 命令面（send/abort/resume/branch）——宿主薄驱动，不复制引擎机制。
 *
 * send 走 Runtime 在途 run 登记 + engine.ainvoke（续链语义），每轮挂一条
 * 事件文件传输；abort 经 Runtime.abort_current_run（JS 平台取消模型
 * 降级：取消投递后引擎后台自然收尾，CANCELLED 快照锚点由 runtime 写）；
 * resume = 审批决议重入（runtime.resume_run，挂起卡读取/注入校验仍归引擎）；
 * branch = 从既有链叶续跑的分支回合（parent 锚点 = 会话分支语义：引擎
 * 以 resume_from 锚定历史叶，产生新链叶，原叶保留为父节点）。
 * 会话簿记收尾统一经 HostSessionStore（宿主薄服务唯一写点）。
 * 并发纪律：单 host 串行跑回合（引擎顶层 run 非并发安全，先进先出队列）。
 */

import type { RunTaskHandle, Storage } from '@ink-ts/engine';

import { HostSessionStore } from '../sessions/store.js';
import type { FileEventsTransport } from '../transport.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

interface RoundParams {
  input: string;
  thread_id?: string | null;
  round_id?: string | null;
  trace_id?: string | null;
}

/** rounds.send 参数校验。 */
function asParams(raw: unknown): RoundParams {
  const params = raw as RoundParams | null;
  if (typeof params !== 'object' || params === null || typeof params.input !== 'string') {
    throw new BridgeError('rounds.send 需 params.input（字符串）', 'invalid_params');
  }
  if (params.input === '') {
    throw new BridgeError('rounds.send input 不能为空', 'invalid_params');
  }
  return params;
}

/** 默认 id（进程内短 id；跨进程审计用 trace_id 自定）。 */
function shortId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** rounds.branch 参数（leaf = 分支锚点 checkpoint_id，缺省 = 链尾）。 */
interface BranchParams {
  thread_id: string;
  leaf?: number | null;
  input?: string | null;
}

function asBranchParams(raw: unknown): BranchParams {
  const params = raw as BranchParams | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError('rounds.branch 需 params.thread_id', 'invalid_params');
  }
  if (params.leaf !== undefined && params.leaf !== null && !Number.isInteger(params.leaf)) {
    throw new BridgeError('rounds.branch leaf 须为 checkpoint_id 整数', 'invalid_params');
  }
  return { thread_id: params.thread_id, leaf: params.leaf ?? null, input: params.input ?? '' };
}

/** 单次引擎回合结果形态（send/branch 共用）。 */
interface RoundOutcome {
  reason: string;
  checkpoint_id: number | null;
  state: Record<string, unknown>;
}

/** 可取消 run 中止信号（trackedRun 投递取消时的归一异常）。 */
class RoundAbortedError extends Error {
  constructor() {
    super('round aborted');
    this.name = 'RoundAbortedError';
  }
}

/** 可取消 run 任务句柄（Runtime RunTaskHandle seam：cancel = 投递中止）。 */
function trackedRun(
  promise: Promise<RoundOutcome>,
  controller: AbortController,
): RunTaskHandle & { promise: Promise<RoundOutcome> } {
  let settled = false;
  const tracked = new Promise<RoundOutcome>((resolve, reject) => {
    promise.then(
      (value) => {
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        settled = true;
        reject(error);
      },
    );
    controller.signal.addEventListener(
      'abort',
      () => {
        if (settled) return;
        reject(new RoundAbortedError());
      },
      { once: true },
    );
  });
  return {
    done: () => settled,
    cancel: () => controller.abort(),
    then: (onfulfilled, onrejected) =>
      tracked.then(
        onfulfilled as (value: RoundOutcome) => unknown,
        onrejected as (reason: unknown) => unknown,
      ),
    promise: tracked,
  } as RunTaskHandle & { promise: Promise<RoundOutcome> };
}

/** rounds 方法组构造（每 host 装配闭包：串行回合队列 + 事件文件传输）。 */
export function buildRoundsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  let queue: Promise<void> = Promise.resolve();
  const sessions = new HostSessionStore(
    () => deps.runtime.storage as unknown as Storage | null,
  );

  /** 队列保护：串行执行一次引擎回合。返回事件文件传输（统计用）。 */
  async function serialized<T>(
    run: (transport: FileEventsTransport) => Promise<T>,
  ): Promise<{ value: T; transport: FileEventsTransport }> {
    const transport = deps.host.build_transport() as FileEventsTransport;
    const prev = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const value = await run(transport);
      return { value, transport };
    } finally {
      release();
    }
  }

  /** 驱动一次引擎顶层 run（在途登记 + 可取消投递）；abort 抛 round_aborted。 */
  async function driveRun(
    engine: NonNullable<HostBridgeDeps['runtime']['engine']>,
    thread_id: string,
    round_id: string,
    state: Record<string, unknown>,
    options: {
      continue_chain?: boolean;
      resume_from?: number | null;
      trace_id?: string | null;
      transport: FileEventsTransport;
    },
  ): Promise<RoundOutcome> {
    const runtime = deps.runtime;
    const ticket = runtime.begin_run(thread_id);
    const controller = new AbortController();
    try {
      const inner = engine.ainvoke(state, {
        thread_id,
        round_id,
        continue_chain: options.continue_chain ?? false,
        resume_from: options.resume_from ?? null,
        trace_id: options.trace_id ?? null,
        transports: [options.transport],
      });
      const task = trackedRun(inner, controller);
      runtime.register_active_run_task(task);
      return await task.promise;
    } finally {
      controller.abort();
      runtime.end_run(ticket);
    }
  }

  /** 回合结局归一 + 会话簿记收尾。 */
  async function settle(
    thread_id: string,
    round_id: string,
    outcome: RoundOutcome,
  ): Promise<void> {
    const reason = outcome.reason === 'ok' ? 'ok' : outcome.reason;
    await sessions.touch(thread_id, {
      round_id,
      outcome: reason,
      checkpoint_id: outcome.checkpoint_id,
    });
  }

  const send: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asParams(raw);
    const runtime = deps.runtime;
    const engine = runtime.engine;
    if (engine === null) {
      throw new BridgeError('运行时引擎未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    const thread_id = params.thread_id ?? shortId('t');
    const round_id = params.round_id ?? shortId('r');
    const trace_id = params.trace_id ?? shortId('trace');

    let result: RoundOutcome;
    let transport: FileEventsTransport;
    try {
      const ran = await serialized((t) =>
        driveRun(engine, thread_id, round_id, { input: params.input }, {
          continue_chain: true,
          trace_id,
          transport: t,
        }),
      );
      result = ran.value;
      transport = ran.transport;
    } catch (error) {
      if (error instanceof RoundAbortedError) {
        await sessions.touch(thread_id, { round_id, outcome: 'aborted' });
        throw new BridgeError(
          '回合已中止（rounds.abort 已投递；引擎后台自然收尾）',
          'round_aborted',
        );
      }
      throw error;
    }
    await settle(thread_id, round_id, result);
    return {
      thread_id,
      round_id,
      trace_id,
      reason: result.reason,
      checkpoint_id: result.checkpoint_id,
      reply: result.state['reply'] ?? null,
      events: {
        count: transport.events.length,
        types: [...new Set(transport.events.map((event) => event.type))].sort(),
      },
    };
  };

  const abort: BridgeHandler = async (): Promise<{ aborted: boolean }> => {
    const runtime = deps.runtime;
    try {
      const aborted = await runtime.abort_current_run();
      return { aborted };
    } catch {
      return { aborted: false };
    }
  };

  const resume: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { thread_id?: unknown; decision?: unknown } | null;
    if (
      typeof params !== 'object'
      || params === null
      || typeof params.thread_id !== 'string'
      || params.thread_id === ''
    ) {
      throw new BridgeError('rounds.resume 需 thread_id', 'invalid_params');
    }
    if (typeof params.decision !== 'object' || params.decision === null) {
      throw new BridgeError('rounds.resume 需 decision（审批决议注入）', 'invalid_params');
    }
    const result = await deps.runtime.resume_run(
      params.thread_id,
      params.decision as Record<string, unknown>,
    );
    return { thread_id: params.thread_id, resumed: true, result };
  };

  /** 分支回合：以链叶为锚点续跑（历史叶保留为父，新叶成为链尾）。 */
  const branch: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asBranchParams(raw);
    const runtime = deps.runtime;
    const engine = runtime.engine;
    if (engine === null) {
      throw new BridgeError('运行时引擎未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    const storage = runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const chain = (await storage.chain_index(params.thread_id).catch(() => [])) as Array<{
      checkpoint_id: number;
    }>;
    if (chain.length === 0) {
      throw new BridgeError('该会话无链叶可分支（先跑 rounds.send）', 'no_checkpoint');
    }
    const chainIds = new Set(chain.map((link) => link.checkpoint_id));
    const anchor =
      params.leaf !== null && params.leaf !== undefined
        ? params.leaf
        : chain.reduce(
            (max, link) => (link.checkpoint_id > max ? link.checkpoint_id : max),
            chain[0]!.checkpoint_id,
          );
    if (!chainIds.has(anchor)) {
      throw new BridgeError(`分支锚点不在该会话链上: #${anchor}`, 'invalid_leaf');
    }
    const round_id = shortId('r');
    let result: RoundOutcome;
    try {
      const ran = await serialized((t) =>
        driveRun(engine, params.thread_id, round_id, { input: params.input }, {
          resume_from: anchor,
          trace_id: shortId('trace'),
          transport: t,
        }),
      );
      result = ran.value;
    } catch (error) {
      if (error instanceof RoundAbortedError) {
        await sessions.touch(params.thread_id, { round_id, outcome: 'aborted' });
        throw new BridgeError(
          '分支回合已中止（rounds.abort 已投递）',
          'round_aborted',
        );
      }
      throw error;
    }
    await settle(params.thread_id, round_id, result);
    const tree = await sessions.branch_tree(params.thread_id);
    return {
      thread_id: params.thread_id,
      round_id,
      leaf: result.checkpoint_id,
      tree,
    };
  };

  return new Map<string, BridgeHandler>([
    ['rounds.send', send],
    ['rounds.abort', abort],
    ['rounds.resume', resume],
    ['rounds.branch', branch],
  ]);
}
