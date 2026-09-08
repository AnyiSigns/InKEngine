import type { RoundsCommand } from './commands.generated.js';
export { ROUNDS_COMMANDS, type RoundsCommand } from './commands.generated.js';
// gate: 超限(385 行) - 回合驱动单一命令面（队列保护/在途登记/附件文档注入与簿记收尾成对同文件防漂移）
/**
 * rounds 命令面（send/abort/resume/branch）——宿主薄驱动，不复制引擎机制。
 *
 * send 走 Runtime run 级组装回合（assemble_round：本轮图 = 组装产物图，非
 * 默认图；每次 send 现读能力记录 max_tool_rounds → 覆写本轮 llm_decider
 * config）+ 在途 run 登记（队列保护）；abort 经 Runtime.abort_current_run
 * （JS 平台取消模型降级：取消投递后引擎后台自然收尾，CANCELLED 快照锚点由
 * runtime 写）；resume = 审批决议重入（runtime.resume_run，按 checkpoint 关联
 * 图重建本轮 Engine）；branch = 从既有链叶续跑的分支回合（runtime.resume_round
 * 按锚点 checkpoint 关联图重建，同语义续跑新叶）。
 * 会话簿记收尾统一经 HostSessionStore（宿主薄服务唯一写点）。
 * 并发纪律：单 host 串行跑回合（引擎顶层 run 非并发安全，先进先出队列）。
 */

import type { RunTaskHandle, Storage, DisplayMessage } from '@ink-ts/engine';
import { DisplayStreamCollector } from '@ink-ts/engine';

import { HostSessionStore } from '../sessions/store.js';
import type { FileEventsTransport } from '../transport.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { prepareRoundInput } from './round_attachments.js';
import type { PreparedRound } from './round_attachments.js';

interface RoundParams {
  input: string;
  thread_id?: string | null;
  round_id?: string | null;
  trace_id?: string | null;
  /** 附件载荷（image/video/document；document 文本经 doc 执行体注入）。 */
  attachments?: unknown;
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
  if (params.attachments !== undefined && !Array.isArray(params.attachments)) {
    throw new BridgeError('rounds.send attachments 须为数组', 'invalid_params');
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
export function buildRoundsCommands(deps: HostBridgeDeps): Readonly<Record<RoundsCommand, BridgeHandler>> {
  let queue: Promise<void> = Promise.resolve();
  const sessions = new HostSessionStore(
    () => deps.runtime.storage as unknown as Storage | null,
  );

  /** 队列保护：串行执行一次引擎回合。返回事件文件传输（统计用）。 */
  async function serialized<T>(
    run: (transport: FileEventsTransport) => Promise<T>,
  ): Promise<{ value: T; transport: FileEventsTransport }> {
    // 队列内请求开始执行时二次确认空闲：restore 维护期到达队首的在途
    // 请求在此被拒（restore 会中止/排空当前 run，不给目录替换留写窗口）
    if (deps.gate !== undefined) deps.gate.assertIdle();
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

  /** 驱动一次引擎顶层回合（在途登记 + 可取消投递）；abort 抛 round_aborted。 */
  async function driveRound(
    runtime: HostBridgeDeps['runtime'],
    thread_id: string,
    run: (transport: FileEventsTransport) => Promise<RoundOutcome>,
    transport: FileEventsTransport,
  ): Promise<RoundOutcome> {
    const ticket = runtime.begin_run(thread_id);
    const controller = new AbortController();
    try {
      const inner = run(transport);
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

/** 附件归一 + 文档文本注入（失败 = 显式拒绝，不静默降级入会话）。 */
async function prepare(
  params: Pick<RoundParams, 'input' | 'attachments'>,
  deps: HostBridgeDeps,
): Promise<PreparedRound> {
  try {
    return await prepareRoundInput(params.input, params.attachments, {
      docParse: deps.docParse,
      attachmentDir: deps.attachment_dir,
      docTextCap: deps.docTextCap,
    });
  } catch (error) {
    throw new BridgeError(
      `附件处理失败: ${error instanceof Error ? error.message : String(error)}`,
      'attachment_error',
    );
  }
}

/** 种子 state（input 含文档注入文本；attachments 随载荷入引擎，保留 path）。 */
function seedState(prepared: PreparedRound): Record<string, unknown> {
  return {
    input: prepared.input,
    ...(prepared.attachments.length > 0 ? { attachments: prepared.attachments } : {}),
  };
}

/** 回合结果附可见告警（warnings 非空才带）。 */
function resultWarnings(warnings: string[]): Record<string, unknown> {
  return warnings.length > 0 ? { warnings } : {};
}

/** 展示态消息流：user 输入展示条目前置 + 事件展示聚合器采集的 think/tool/正文。
 *  host 持久化到 host.sessions（sqlite），刷新据此恢复前端完整消息流。 */
function buildDisplayMessages(input: string, collected: readonly DisplayMessage[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  if (input.trim() !== '') {
    messages.push({ kind: 'text', role: 'user', content: input, step_id: 'display:u' });
  }
  messages.push(...collected);
  return messages;
}

  const send: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asParams(raw);
    const runtime = deps.runtime;
    if (runtime.storage === null) {
      throw new BridgeError('运行时存储未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    const thread_id = params.thread_id ?? shortId('t');
    const round_id = params.round_id ?? shortId('r');
    const trace_id = params.trace_id ?? shortId('trace');
    const prepared = await prepare(params, deps);

    // 工具回合上限活读面（与 capability/approval 同模式：每次 send 现取能力
    // 记录，put 后下轮即生效；无记录 = 引擎缺省）。绑定边界 = 宿主会话级单点
    // 配置（capability.json 当前为全局单档，非 per-thread/per-model——模型切换
    // 走 models 槽位不影响本记录；per-thread/model 维度待能力记录演进再扩展）。
    const capability = deps.capability?.get() ?? null;
    const max_tool_rounds =
      capability !== null && typeof capability.max_tool_rounds === 'number'
        ? capability.max_tool_rounds
        : undefined;

    let result: RoundOutcome;
    let transport: FileEventsTransport;
    // 展示态采集：从引擎事件流派生 thinking/tool/正文（宿主持久化；独立于
    // 上下文 messages，不喂模型）。收尾落 host.sessions，刷新据此恢复。
    const displayCollector = new DisplayStreamCollector();
    try {
      const ran = await serialized((t) =>
        driveRound(runtime, thread_id, (transportForRun) =>
          runtime.assemble_round({
            state: seedState(prepared),
            thread_id,
            round_id,
            trace_id,
            ...(max_tool_rounds !== undefined ? { max_tool_rounds } : {}),
            transports: [transportForRun, displayCollector],
          }),
          t,
        ),
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
    // 展示态持久化：user 输入展示前置 + 事件展示聚合器采集的 think/tool/正文
    const displayMessages = buildDisplayMessages(prepared.input, displayCollector.getMessages());
    await sessions.set_display_messages(thread_id, displayMessages);
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
      ...resultWarnings(prepared.warnings),
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
    const prepared = await prepare({ input: params.input ?? '', attachments: undefined }, deps);
    // branch 无附件语义：仅沿用 input（与历史分支行为一致）；保留注入函数
    // 以统一载荷路径——若未来分支带附件在此扩展。
    let result: RoundOutcome;
    try {
      const ran = await serialized((t) =>
        driveRound(runtime, params.thread_id, (transportForRun) =>
          runtime.resume_round({
            thread_id: params.thread_id,
            leaf: anchor,
            state: { input: prepared.input },
            round_id,
            trace_id: shortId('trace'),
            transports: [transportForRun],
          }),
          t,
        ),
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
      ...resultWarnings(prepared.warnings),
    };
  };

  return {
    'rounds.send': send,
    'rounds.abort': abort,
    'rounds.resume': resume,
    'rounds.branch': branch,
  };
}
