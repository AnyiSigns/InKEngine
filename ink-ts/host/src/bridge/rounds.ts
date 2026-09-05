/**
 * rounds 命令面（send/abort/resume）——宿主薄驱动，不复制引擎机制。
 *
 * send 走 Runtime 在途 run 登记 + engine.ainvoke（续链语义），每轮挂一条
 * 事件文件传输（D9）；abort 经 Runtime.abort_current_run（JS 平台取消模型
 * 降级：取消投递后引擎后台自然收尾，CANCELLED 快照锚点由 runtime 写）；
 * resume = 审批决议重入（runtime.resume_run，挂起卡读取/注入校验仍归引擎）。
 * 并发纪律：单 host 串行跑回合（引擎顶层 run 非并发安全，先进先出队列）。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import type { FileEventsTransport } from '../transport.js';
import type { RunTaskHandle } from '@ink-ts/engine';

interface RoundParams {
  input: string;
  thread_id?: string | null;
  round_id?: string | null;
  trace_id?: string | null;
}

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

/** 会话索引 upsert（薄宿主数据；S6 会话域服务在此基础上定稿）。 */
async function upsertSession(
  deps: HostBridgeDeps,
  thread_id: string,
  round_id: string,
  outcome: string,
): Promise<void> {
  const storage = deps.runtime.storage;
  if (storage === null) return;
  const now = new Date().toISOString();
  const existing = await storage.get_record('host.sessions', thread_id).catch(() => null);
  const record: Record<string, unknown> =
    existing !== null
      ? { ...existing }
      : {
          thread_id,
          title: '',
          created_at: now,
          updated_at: now,
          round_count: 0,
          last_round_id: null,
        };
  record['updated_at'] = now;
  record['round_count'] = (Number(record['round_count'] ?? 0) || 0) + 1;
  record['last_round_id'] = round_id;
  record['last_outcome'] = outcome;
  await storage.put_record('host.sessions', thread_id, record).catch(() => undefined);
}

/** rounds 方法组构造（每 host 装配闭包：串行回合队列 + 事件文件传输）。 */
export function buildRoundsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  let queue: Promise<void> = Promise.resolve();

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
    const transport = deps.host.build_transport() as FileEventsTransport;

    const prev = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;

    let controller: AbortController | null = null;
    let result: { reason: string; checkpoint_id: number | null; state: Record<string, unknown> } | null =
      null;
    const ticket = runtime.begin_run(thread_id);
    try {
      controller = new AbortController();
      const inner = engine.ainvoke(
        { input: params.input },
        {
          thread_id,
          round_id,
          continue_chain: true,
          trace_id,
          transports: [transport],
        },
      );
      const task = trackedRun(inner, controller);
      runtime.register_active_run_task(task);
      result = await task.promise;
    } catch (error) {
      const aborted = controller !== null && controller.signal.aborted;
      if (!aborted) throw error;
      await upsertSession(deps, thread_id, round_id, 'aborted');
      throw new BridgeError(
        '回合已中止（rounds.abort 已投递；引擎后台自然收尾）',
        'round_aborted',
      );
    } finally {
      runtime.end_run(ticket);
      release();
    }

    await upsertSession(deps, thread_id, round_id, result.reason === 'ok' ? 'ok' : result.reason);
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

  return new Map<string, BridgeHandler>([
    ['rounds.send', send],
    ['rounds.abort', abort],
    ['rounds.resume', resume],
  ]);
}

interface RoundOutcome {
  reason: string;
  checkpoint_id: number | null;
  state: Record<string, unknown>;
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
        reject(new Error('round aborted'));
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
