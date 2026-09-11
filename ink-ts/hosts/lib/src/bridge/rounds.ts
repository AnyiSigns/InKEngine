import type { RoundsCommand } from './commands.generated.js';
export { ROUNDS_COMMANDS, type RoundsCommand } from './commands.generated.js';
// gate: 超限(1122 行) - 回合双路（execution 主线驱动 + 组装回退 flag）的命令面、簿记、展示、挂卡/注入/中止收尾成对同文件防漂移
/**
 * rounds 命令面（send/abort/resume/branch/fork_trial）——宿主薄驱动，不复制引擎机制。
 *
 * W7-A 主线切换：send/resume **默认走 execution 执行运行时主线**（HostExecutionService
 * runExecution / resumeExecution——作用域转场循环 + W7-D 审批挂卡/运行中注入/中止
 * 收口），桥命令对外签名不变（thread_id/round_id/reason/checkpoint_id/reply 等
 * 既有字段原形态；主线扩展字段只增不改）。组装路径（runtime.assemble_round
 * per-session 组装图）收进内部回退开关：环境变量 `INK_ROUNDS_ASSEMBLY_FALLBACK
 * ∈ 1/true/on` 时 send/resume 走旧组装路（缺省 = execution 主线）；旧路径行为
 * 零改动，供主线缺口兜底与退役前对照，退役任务连同 flag 分支一并移除。
 * 主线回合语义对齐既有面（逐项）：
 * - 审批卡：send 挂起 → 回执 reason='interrupted' + pending{key,payload,
 *   checkpoint_id,run_id}（挂起卡随 exec 链 checkpoint 持久化）→ rounds.resume
 *   (thread_id, decision) 读 exec 链尾卡 → resumeExecution 决议注入续跑出结论；
 *   exec 链无卡 = 回落组装审批卡语义（runtime.resume_run）；
 * - 展示态：执行树事件带（route/merge/user_inject）+ 汇聚点回复投影为
 *   display_messages（user 前置 + thinking 观测 + assistant 正文），
 *   set_display_messages 跨轮累积语义与既有一致（sessions.messages 零感知）；
 * - 会话簿记：每回合写线程链回合归档 checkpoint（薄留痕：无图无计划，供
 *   records.chain / sessions.messages 叶锚点 / sessions.refresh 消息数与兜底
 *   标题），sessions.touch round_id/outcome/checkpoint_id/current_leaf 同点收尾；
 * - 中断注入：同线程有在途主线执行时再次 send → §7.3 injectUserInput 排队至
 *   下一 main 轮消费（立即回执 reason='injected'，不占串行队列）；
 * - abort：主线 run 登记为在途可取消任务（begin_run/register_active_run_task），
 *   rounds.abort 投递后桥立即拒绝（round_aborted）+ markAborted 引擎侧收口。
 * branch/fork_trial 仍属组装链入口（按 checkpoint 关联图/骨架重建；主线回合归档
 * checkpoint 无图 = 引擎显式拒绝），语义随退役任务重定位。
 * 并发纪律：单 host 串行跑回合（引擎顶层 run 非并发安全，先进先出队列）。
 */

import type {
  CheckpointRecord,
  DisplayMessage,
  EngineEvent,
  ExecutionResult,
  RunEvent,
  RunTaskHandle,
  Storage,
} from '@ink-ts/engine';
import {
  CheckpointRecord as CheckpointRecordCtor,
  DisplayStreamCollector,
  EngineEvent as EngineEventCtor,
  STATE_MESSAGES,
  STATE_ROUND_MODEL,
  STATE_ROUND_POSE,
  THREAD_SKELETON_STATE_KEY,
  exec_checkpoint_thread,
  isApprovalPose,
  project_history_baseline,
  user,
} from '@ink-ts/engine';

import { HostSessionStore } from '../sessions/store.js';
import type { FileEventsTransport } from '../transport.js';
import { validate_skeleton_sketch } from '../skeleton.js';
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
  /** 每轮模型选择（model_id/provider 回声 + 推理档位覆盖）。推理字段随回合
   *  state 的 round_model 键带往引擎 llm_decider，构造 LLMParams 生效。 */
  model?: {
    provider?: string;
    model_id?: string;
    reasoning_effort?: string;
    enable_thinking?: boolean;
    thinking_budget?: number;
  };
  /** 审批姿态（auto/review/deny；缺省 = review 现行为）。随回合 state 的
   *  round_pose 键带往引擎：tool_pipeline 在审批/门禁处按 pose 裁定（auto
   *  免弹直过+缺准入会话内授予 / deny 免问直拒；机制校验不受影响）。 */
  pose?: string;
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
  if (params.model !== undefined) {
    if (typeof params.model !== 'object' || params.model === null) {
      throw new BridgeError('rounds.send model 须为对象', 'invalid_params');
    }
    const model = params.model;
    if (
      (model.model_id !== undefined && typeof model.model_id !== 'string')
      || (model.provider !== undefined && typeof model.provider !== 'string')
      || (model.reasoning_effort !== undefined && typeof model.reasoning_effort !== 'string')
      || (model.enable_thinking !== undefined && typeof model.enable_thinking !== 'boolean')
      || (model.thinking_budget !== undefined && typeof model.thinking_budget !== 'number')
    ) {
      throw new BridgeError('rounds.send model 字段类型不合法', 'invalid_params');
    }
  }
  if (params.pose !== undefined && params.pose !== null && !isApprovalPose(params.pose)) {
    throw new BridgeError('rounds.send pose 须为 auto/review/deny', 'invalid_params');
  }
  return params;
}

// ── W7-A 主线开关与纯投影辅助（无闭包状态；退役任务连 flag 分支一并移除）──

/** 组装回退开关（env 每调用现取：真值 = send/resume 走旧组装图回合；缺省 =
 *  execution 执行主线）。仅内部回退用途，不进宿主配置面、web 不感知。 */
const ASSEMBLY_FALLBACK_ENV = 'INK_ROUNDS_ASSEMBLY_FALLBACK';

function assemblyFallbackEnabled(): boolean {
  const raw = (process.env[ASSEMBLY_FALLBACK_ENV] ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** 主线回合命名空间 run_id：会话线程一一对应（exec 链 = exec:r:<thread>；
 *  与 execution.run 桥的 run:<seq> 命名空间不相交）。run_id 线程形态约束
 *  非空白、无控制字符、≤96 长度（违规显式拒绝）。 */
const MAINLINE_RUN_PREFIX = 'r:';

function mainlineRunId(thread_id: string): string {
  for (const ch of thread_id) {
    if (ch.charCodeAt(0) < 32 || /\s/.test(ch)) {
      throw new BridgeError('rounds.send thread_id 不能含空白/控制字符（执行主线命名约束）', 'invalid_params');
    }
  }
  const runId = `${MAINLINE_RUN_PREFIX}${thread_id}`;
  if (runId.length > 96) {
    throw new BridgeError('rounds.send thread_id 过长（主线 run_id 上限 96）', 'invalid_params');
  }
  return runId;
}

/** 主线执行结果 → 回合 reason 归一（reply/error/interrupted——组装路既有词表）。 */
function mainlineReason(result: ExecutionResult): string {
  if (result.pending_approval) return 'interrupted';
  if (result.blocked || result.root.outcome === 'failure') return 'error';
  return 'reply';
}

/** 汇聚点产物 → 回合 reply（message 文本优先；纯 JSON 产物序列化透出；
 *  内部回声键 task/attachments 与降级摘要 degraded 不进 reply）。 */
function mainlineReply(result: ExecutionResult): string {
  const product = result.final_product;
  const message = product['message'];
  if (typeof message === 'string' && message.trim() !== '') return message;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(product)) {
    if (key === 'task' || key === 'attachments' || key === 'degraded') continue;
    rest[key] = value;
  }
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : '';
}

/** 主线展示行：user 输入条目（与组装路 display:u 形态一致）。 */
function userDisplayItem(input: string): DisplayMessage {
  return { kind: 'text', role: 'user', content: input, step_id: 'display:u' };
}

/** 主线展示行：执行事件带 → thinking 观测条目（转场/归并/注入；替代组装路
 *  DisplayStreamCollector 的实时 think/tool 流——执行轮事件带为唯一观测面）。 */
function executionThoughtItems(events: readonly RunEvent[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let seq = 0;
  for (const event of events) {
    if (
      !event.action.startsWith('route:')
      && event.action !== 'merge'
      && event.action !== 'user_inject'
    ) {
      continue;
    }
    seq += 1;
    out.push({
      kind: 'thinking',
      role: 'assistant',
      content: `${event.scope} ${event.action}`,
      status: 'completed',
      step_id: `display:x${seq}`,
    });
  }
  return out;
}

/** 主线展示收尾行：回复正文 / 挂起等待提示 / 失败摘要（三选一，回复优先）。 */
function mainlineTailItems(result: ExecutionResult, reply: string, round_id: string): DisplayMessage[] {
  if (result.pending_approval) {
    const key = result.pending_interrupt === null ? '审批' : result.pending_interrupt.key;
    return [{ kind: 'thinking', role: 'assistant', content: `等待审批裁决：${key}`, status: 'completed', step_id: 'display:pending', round: round_id }];
  }
  if (reply !== '') {
    return [{ kind: 'text', role: 'assistant', content: reply, step_id: 'display:a', round: round_id }];
  }
  const degraded = result.degraded_summaries.join('；');
  const summary = degraded !== '' ? degraded : (result.root.error ?? '执行未产出回复');
  return [{ kind: 'thinking', role: 'assistant', content: `（未产出回复）${summary}`, status: 'completed', step_id: 'display:a', round: round_id }];
}

/** 执行事件 → 引擎事件协议形态（转发 FileEventsTransport：事件落文件 JSONL
 *  观测渠道与组装路一致；type = 事件带 action 原词，payload = 执行树坐标）。 */
function execEventAsEngineEvent(
  event: RunEvent,
  meta: { thread_id: string; round_id: string; trace_id: string },
): EngineEvent {
  return new EngineEventCtor({
    type: event.action,
    payload: {
      run_id: event.run_id,
      parent_run_id: event.parent_run_id,
      scope: event.scope,
      detail: event.detail,
    } as EngineEvent['payload'],
    round_id: meta.round_id,
    node: event.scope,
    trace_id: meta.trace_id,
    thread_id: meta.thread_id,
  });
}

/** 主线回合归档 checkpoint：把回合结果薄留痕到**会话线程链**（node/graph_path/
 *  plan/graph_version 全空——不复制引擎的图/消息机制），既有只读投影
 *  records.chain / sessions.messages（叶锚点）/ sessions.refresh（消息数与兜底
 *  标题）零感知延续；返回落库 checkpoint_id 供簿记 current_leaf。写失败 =
 *  降级 null（簿记无叶，结果照收——观测面不击穿回合）。 */
async function writeRoundCheckpoint(
  storage: Storage,
  thread_id: string,
  round_id: string,
  run_id: string,
  reason: string,
  input: string,
  reply: string,
  pendingKey: string | null,
): Promise<number | null> {
  const messages: Record<string, unknown>[] = [];
  if (input.trim() !== '') messages.push({ role: 'user', content: input });
  if (reply !== '') messages.push({ role: 'assistant', content: reply });
  const latest = await storage.get_latest_checkpoint(thread_id).catch(() => null);
  const state: Record<string, unknown> = {
    input,
    reply: reply === '' ? null : reply,
    [STATE_MESSAGES]: messages,
    round_id,
    run_id,
    execution: true,
  };
  if (pendingKey !== null) state['pending_approval_key'] = pendingKey;
  const record = new CheckpointRecordCtor({
    checkpoint_id: 0,
    thread_id,
    node: null,
    graph_path: [],
    state: state as unknown as CheckpointRecord['state'],
    parent_id: latest !== null ? latest.checkpoint_id : null,
    reason,
    created_at: Math.floor(Date.now() / 1000),
    event_seq: 0,
    error: null,
    interrupt: null,
    graph_version: null,
    plan: null,
  });
  try {
    const stored = await storage.put_checkpoint(record, { fork: false });
    return stored.checkpoint_id;
  } catch {
    return null;
  }
}

/** 主线输入连续性桥：既有展示消息链（用户/助手正文）末段投影为本轮 seed
 *  载荷 history 文本（执行回合没有组装式消息链续航——白板/记忆通道接通前的
 *  宿主薄接线，非引擎机制复制）。 */
function historyTextFromDisplay(display: unknown): string {
  if (!Array.isArray(display)) return '';
  const lines: string[] = [];
  for (const item of (display as unknown[]).slice(-16)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row['kind'] !== 'text') continue;
    const role = row['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    const content = row['content'];
    if (typeof content !== 'string' || content.trim() === '') continue;
    lines.push(`${role}: ${content.slice(0, 400)}`);
  }
  const text = lines.join('\n');
  return text.length > 4000 ? text.slice(text.length - 4000) : text;
}

/** 每轮推理覆盖 → 引擎 round_model 键（只带显式推理选择；model_id/provider 是
 *  回声不参与 llm 参数；auto 哨兵 = undefined 不携带 → 引擎回落默认）。 */
function roundModelState(model: NonNullable<RoundParams['model']>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (model.reasoning_effort !== undefined && model.reasoning_effort !== '') {
    out['reasoning_effort'] = model.reasoning_effort;
  }
  if (model.enable_thinking !== undefined) out['enable_thinking'] = model.enable_thinking;
  if (model.thinking_budget !== undefined && model.thinking_budget > 0) {
    out['thinking_budget'] = model.thinking_budget;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 每轮审批姿态 → 引擎 round_pose 键（auto/deny 才携带；review/缺省 = 引擎
 *  缺省语义，不落键保持零漂移）。 */
function roundPoseState(pose: string | null | undefined): Record<string, unknown> | null {
  if (pose === undefined || pose === null) return null;
  if (pose === 'review') return null;
  return { [STATE_ROUND_POSE]: pose };
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

/** rounds.fork_trial 参数（thread_id = 源会话；trial_thread_id 可显式指定新线程）。 */
interface ForkTrialParams {
  thread_id: string;
  input?: string | null;
  trial_thread_id?: string | null;
}

function asForkTrialParams(raw: unknown): ForkTrialParams {
  const params = raw as ForkTrialParams | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError('rounds.fork_trial 需 params.thread_id（源会话）', 'invalid_params');
  }
  if (params.trial_thread_id !== undefined && params.trial_thread_id !== null
    && typeof params.trial_thread_id !== 'string') {
    throw new BridgeError('rounds.fork_trial trial_thread_id 须为字符串', 'invalid_params');
  }
  return {
    thread_id: params.thread_id,
    input: params.input ?? null,
    trial_thread_id: params.trial_thread_id ?? null,
  };
}

/** rounds.resume 参数（决议形态与 approval.resolve 一致：字符串或含 decision 对象）。 */
function asResumeParams(raw: unknown): { thread_id: string; decision: unknown } {
  const params = raw as { thread_id?: unknown; decision?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError('rounds.resume 需 thread_id', 'invalid_params');
  }
  const decision = params.decision;
  const decisionOk
    = typeof decision === 'string'
    || (typeof decision === 'object' && decision !== null && !Array.isArray(decision));
  if (!decisionOk) {
    throw new BridgeError('rounds.resume 需 decision（审批决议注入：字符串或含 decision 对象）', 'invalid_params');
  }
  return { thread_id: params.thread_id, decision };
}

/** 骨架数据深拷贝（读 checkpoint state 后隔离改写；非对象 = null）。 */
function copySkeleton(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
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
function trackedRun<T>(
  promise: Promise<T>,
  controller: AbortController,
): RunTaskHandle & { promise: Promise<T> } {
  let settled = false;
  const tracked = new Promise<T>((resolve, reject) => {
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
    then: (
      onfulfilled?: ((value: T) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) =>
      tracked.then(
        onfulfilled as (value: T) => unknown,
        onrejected as (reason: unknown) => unknown,
      ),
    promise: tracked,
  } as unknown as RunTaskHandle & { promise: Promise<T> };
}

/** rounds 方法组构造（每 host 装配闭包：串行回合队列 + 事件文件传输）。 */
export function buildRoundsCommands(deps: HostBridgeDeps): Readonly<Record<RoundsCommand, BridgeHandler>> {
  let queue: Promise<void> = Promise.resolve();
  const sessions = new HostSessionStore(
    () => deps.runtime.storage as unknown as Storage | null,
  );
  /** 在途主线执行登记表（thread_id → run_id + 注入排队文本；同线程再 send =
   *  §7.3 注入；注入展示条目延迟到本轮收尾统一落流，保持展示时序正确）。 */
  const activeMainlineRuns = new Map<string, { run_id: string; injects: string[] }>();

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
  async function driveRound<T>(
    runtime: HostBridgeDeps['runtime'],
    thread_id: string,
    run: (transport: FileEventsTransport) => Promise<T>,
    transport: FileEventsTransport,
  ): Promise<T> {
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

  /** 驱动一次主线执行回合（在途登记 + 事件带收集；round_aborted 只可能在 run
   *  settled 前投递，调用方 catch 即运行中被中止 → markAborted 引擎侧收口）。 */
  async function driveMainline<T>(
    runtime: HostBridgeDeps['runtime'],
    thread_id: string,
    runEvents: RunEvent[],
    run: (onEvent: (event: RunEvent) => void) => Promise<T>,
  ): Promise<{ value: T }> {
    const ticket = runtime.begin_run(thread_id);
    const controller = new AbortController();
    try {
      const task = trackedRun(
        run((event) => {
          runEvents.push(event);
        }),
        controller,
      );
      runtime.register_active_run_task(task);
      const value = await task.promise;
      return { value };
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

  /** 组装路展示态消息流：user 输入展示条目前置 + 事件展示聚合器采集的
   *  think/tool/正文。host 持久化到 host.sessions（sqlite），刷新据此恢复。 */
  function buildDisplayMessages(input: string, collected: readonly DisplayMessage[]): DisplayMessage[] {
    const messages: DisplayMessage[] = [];
    if (input.trim() !== '') {
      messages.push({ kind: 'text', role: 'user', content: input, step_id: 'display:u' });
    }
    messages.push(...collected);
    return messages;
  }

  /** 主线执行回合驱动（send 新 run / resume 挂起续跑共用）：串行队列 + 在途
   *  登记由调用方持有（send 在首个 await 前登记；abort = markAborted + 簿记
   *  aborted + round_aborted 显式拒绝）。 */
  async function runMainlineRound<T>(
    service: NonNullable<HostBridgeDeps['execution']>,
    thread_id: string,
    round_id: string,
    run_id: string,
    run: (onEvent: (event: RunEvent) => void) => Promise<T>,
  ): Promise<{ value: T; events: RunEvent[]; transport: FileEventsTransport }> {
    const runtime = deps.runtime;
    const runEvents: RunEvent[] = [];
    try {
      const ran = await serialized(() => driveMainline(runtime, thread_id, runEvents, run));
      return { value: ran.value.value, events: runEvents, transport: ran.transport };
    } catch (error) {
      if (error instanceof RoundAbortedError) {
        service.markAborted(run_id);
        await sessions.touch(thread_id, { round_id, outcome: 'aborted' });
        throw new BridgeError(
          '回合已中止（rounds.abort 已投递；引擎后台自然收尾）',
          'round_aborted',
        );
      }
      throw error;
    }
  }

  /** 主线回合收尾：事件文件确定性落盘 → 回合归档 checkpoint → 簿记 settle →
   *  展示态追加（user 原始输入 + 运行中注入行按序）→ 组装同形态回执 +
   *  主线扩展字段（只增不改）。 */
  async function finishMainlineRound(
    runtime: HostBridgeDeps['runtime'],
    thread_id: string,
    round_id: string,
    trace_id: string,
    run_id: string,
    input: string,
    result: ExecutionResult,
    transport: FileEventsTransport,
    events: RunEvent[],
    injectedTexts: readonly string[],
  ): Promise<unknown> {
    const storage = deps.runtime.storage as unknown as Storage | null;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    for (const event of events) {
      await transport.send(execEventAsEngineEvent(event, { thread_id, round_id, trace_id }));
    }
    const reason = mainlineReason(result);
    const reply = mainlineReply(result);
    const pendingKey = result.pending_approval && result.pending_interrupt !== null
      ? result.pending_interrupt.key
      : null;
    let checkpointId: number | null = null;
    if (runtime.storage !== null) {
      checkpointId = await writeRoundCheckpoint(
        storage,
        thread_id,
        round_id,
        run_id,
        reason,
        input,
        reply,
        pendingKey,
      );
    }
    await settle(thread_id, round_id, { reason, checkpoint_id: checkpointId, state: {} });
    const displayMessages: DisplayMessage[] = [
      ...(input.trim() !== '' ? [userDisplayItem(input)] : []),
      ...injectedTexts.map((text) => userDisplayItem(text)),
      ...executionThoughtItems(result.events),
      ...mainlineTailItems(result, reply, round_id),
    ];
    await sessions.set_display_messages(thread_id, displayMessages);
    return {
      thread_id,
      round_id,
      trace_id,
      reason,
      checkpoint_id: checkpointId,
      reply: reply === '' ? null : reply,
      events: {
        count: transport.events.length,
        types: [...new Set(transport.events.map((event) => event.type))].sort(),
      },
      // 主线扩展字段（既有消费方无视增量；UI 据此挂接执行树/挂起卡，W7-A）
      run_id,
      execution_outcome: result.root.outcome,
      blocked: result.blocked,
      block_reason: result.block_reason,
      pending_approval: result.pending_approval,
      pending: result.pending_approval
        ? {
            key: result.pending_interrupt === null ? null : result.pending_interrupt.key,
            payload: result.pending_interrupt === null ? {} : result.pending_interrupt.payload,
            checkpoint_id: result.resume_checkpoint_id,
            run_id,
          }
        : null,
      degraded_summaries: result.degraded_summaries,
      error: result.root.error,
    };
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

    // W7-A 双路开关：默认 execution 执行主线；组装保留为内部回退路。
    // 在途登记必须在首个 await 之前（并发 send 的同步前缀即可见），否则
    // 「运行中发话」判定漏检退化为排队新回合。
    if (!assemblyFallbackEnabled()) {
      const service = deps.execution;
      if (service === undefined || service === null) {
        throw new BridgeError('执行运行时未装配（宿主 execution service 缺位）', 'execution_unavailable');
      }
      const run_id = mainlineRunId(thread_id);
      const active = activeMainlineRuns.get(thread_id);
      if (active !== undefined) {
        // 中断注入入口（§7.3）：同线程有在途主线执行 → 本轮发话（含附件
        // 文档正文）并入执行输入队，排队至下一 main 轮消费，不占串行队列；
        // 展示条目延迟到该 run 收尾统一落流（保证 user 行时序正确）。
        const injectedRound = await prepare(params, deps);
        service.injectUserInput(run_id, injectedRound.input);
        active.injects.push(injectedRound.input);
        await sessions.touch(thread_id, { round_id, outcome: 'injected' });
        return {
          thread_id,
          round_id,
          trace_id,
          reason: 'injected',
          checkpoint_id: null,
          reply: null,
          injected: true,
          run_id,
          events: { count: 1, types: ['user_inject'] },
          ...resultWarnings(injectedRound.warnings),
        };
      }
      const entry = { run_id, injects: [] as string[] };
      activeMainlineRuns.set(thread_id, entry);
      // 上一 run 未消费的注入排队不得串入本 run 首轮语义（新 run 起点清队；
      // 清队须在登记后的同一同步段——此后到达的注入一律归属本 run）
      service.clearUserInput(run_id);
      try {
        const prepared = await prepare(params, deps);
        return await sendViaExecution(service, entry, params, thread_id, round_id, trace_id, prepared);
      } catch (error) {
        await flushAbortedInjectionDisplay(thread_id, entry);
        throw error;
      } finally {
        activeMainlineRuns.delete(thread_id);
      }
    }

    const prepared = await prepare(params, deps);
    // ── 组装回退路（flag-on；既有语义零改动，退役任务移除）──
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
    // 待生效骨架草稿（skeleton.edit 校验挂载产物）消费：作为本轮 state 的显式
    // 骨架种子（引擎 _seed_skeleton 优先沿种子推进）；回合成功收尾后清除——
    // 失败/中止保留草稿供重试（不丢声明式修改意图）。
    const state = seedState(prepared);
    const roundModel = params.model !== undefined ? roundModelState(params.model) : null;
    if (roundModel !== null) state[STATE_ROUND_MODEL] = roundModel;
    const roundPose = roundPoseState(params.pose);
    if (roundPose !== null) state[STATE_ROUND_POSE] = roundPose[STATE_ROUND_POSE];
    const draft = await sessions.peek_skeleton_draft(thread_id);
    const hasDraft = draft !== null;
    if (hasDraft) state[THREAD_SKELETON_STATE_KEY] = draft;
    // 展示态采集：从引擎事件流派生 thinking/tool/正文（宿主持久化；独立于
    // 上下文 messages，不喂模型）。收尾落 host.sessions，刷新据此恢复。
    const displayCollector = new DisplayStreamCollector();
    try {
      const ran = await serialized((t) =>
        driveRound(runtime, thread_id, (transportForRun) =>
          runtime.assemble_round({
            state,
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
    if (hasDraft) await sessions.set_skeleton_draft(thread_id, null);
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

  /** 主线回合执行体（在途登记由 send 在首个 await 前持有）。 */
  async function sendViaExecution(
    service: NonNullable<HostBridgeDeps['execution']>,
    entry: { run_id: string; injects: string[] },
    params: RoundParams,
    thread_id: string,
    round_id: string,
    trace_id: string,
    prepared: PreparedRound,
  ): Promise<unknown> {
    const run_id = entry.run_id;
    const history = historyTextFromDisplay(
      (await sessions.get(thread_id).catch(() => null))?.display_messages,
    );
    const seedPayload: Record<string, unknown> = {};
    if (history !== '') seedPayload['history'] = history;
    if (prepared.attachments.length > 0) seedPayload['attachments'] = prepared.attachments;
    const ran = await runMainlineRound(
      service,
      thread_id,
      round_id,
      run_id,
      (onEvent) =>
        service.runExecution(
          {
            task: prepared.input,
            run_id,
            ...(Object.keys(seedPayload).length > 0 ? { seed_payload: seedPayload } : {}),
          },
          { pose: params.pose ?? null, hang: true, onEvent },
        ),
    );
    const finished = await finishMainlineRound(
      deps.runtime,
      thread_id,
      round_id,
      trace_id,
      run_id,
      prepared.input,
      ran.value,
      ran.transport,
      ran.events,
      entry.injects,
    );
    entry.injects.length = 0;
    return finished;
  }

  /** 主线回合中止收口：未被收尾消费的注入行补落展示流（run 夭折时注入文本
   *  不凭空消失；簿记 aborted 已由 runMainlineRound touch）。 */
  async function flushAbortedInjectionDisplay(
    thread_id: string,
    entry: { run_id: string; injects: string[] },
  ): Promise<void> {
    if (entry.injects.length === 0) return;
    await sessions
      .set_display_messages(thread_id, entry.injects.map((text) => userDisplayItem(text)))
      .catch(() => undefined);
    entry.injects.length = 0;
  }

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
    const params = asResumeParams(raw);
    const runtime = deps.runtime;
    const service = deps.execution;
    // 主线挂卡续跑：exec 链（exec:<run_id>）链尾挂有 interrupt → resumeExecution
    // （读锚点卡键 → 决议注入 → checkpoint 恢复，W7-D 协议）；主线无挂卡/flag
    // 回退 = 组装审批卡既有语义（runtime.resume_run 按 checkpoint 关联图重建）。
    if (
      !assemblyFallbackEnabled()
      && service !== undefined
      && service !== null
      && runtime.storage !== null
    ) {
      let runId: string | null = null;
      try {
        runId = mainlineRunId(params.thread_id);
      } catch {
        runId = null;
      }
      if (runId !== null) {
        const tail = await runtime.storage
          .get_latest_checkpoint(exec_checkpoint_thread(runId))
          .catch(() => null);
        if (tail !== null && tail.interrupt !== null) {
          return await resumeViaExecution(service, params.thread_id, runId, tail.checkpoint_id, params.decision);
        }
        // 主线 exec 链无挂卡（或该线程从未走过主线）→ 回落组装审批卡语义
        // （resume_run 自报无卡/无图错误，既有形态不变）
      }
    }
    const result = await runtime.resume_run(
      params.thread_id,
      params.decision as Record<string, unknown>,
    );
    return { thread_id: params.thread_id, resumed: true, result };
  };

  /** 主线挂起续跑（决议注入 → checkpoint 恢复 → 回合收尾；abort/队列同 send）。
   *  同步前缀即在途登记（续跑窗口内的用户发话 = 注入本 run）。 */
  async function resumeViaExecution(
    service: NonNullable<HostBridgeDeps['execution']>,
    thread_id: string,
    run_id: string,
    checkpointId: number,
    decision: unknown,
  ): Promise<unknown> {
    const round_id = shortId('r');
    const trace_id = shortId('trace');
    // 续跑窗口即在途登记（同线程用户发话 = 注入续跑 run；已有活动登记则复用）
    const existing = activeMainlineRuns.get(thread_id);
    const entry = existing ?? { run_id, injects: [] as string[] };
    if (existing === undefined) activeMainlineRuns.set(thread_id, entry);
    let ran: { value: ExecutionResult; events: RunEvent[]; transport: FileEventsTransport };
    try {
      ran = await runMainlineRound(
        service,
        thread_id,
        round_id,
        run_id,
        (onEvent) => service.resumeExecution(run_id, checkpointId, decision, { hang: true, onEvent }),
      );
    } catch (error) {
      if (existing === undefined) activeMainlineRuns.delete(thread_id);
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('无挂起卡')
        || message.includes('恢复锚点')
        || message.includes('不属于执行')
      ) {
        throw new BridgeError(message, 'no_pending_approval');
      }
      throw error;
    }
    if (existing === undefined) activeMainlineRuns.delete(thread_id);
    const finished = await finishMainlineRound(
      deps.runtime,
      thread_id,
      round_id,
      trace_id,
      run_id,
      '',
      ran.value,
      ran.transport,
      ran.events,
      entry.injects,
    );
    entry.injects.length = 0;
    return { thread_id, resumed: true, result: finished };
  }

  /** 分支回合：以链叶为锚点续跑（历史叶保留为父，新叶成为链尾）。
   *  W7-A：branch 仍属组装链入口（resume_round 按 checkpoint 关联图重建）——
   *  主线回合归档 checkpoint 无 _round_graph，主线线程分支 = 引擎显式拒绝；
   *  组装链语义随退役任务重定位（本波零回退）。 */
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
    // 会话骨架随分支延续（P4 可分接线）：resume 路径不重嵌 checkpoint 骨架，
    // 分支 state 显式携带锚点骨架（_thread_skeleton）→ 新叶 checkpoint 落骨架，
    // 分支后续回合沿骨架推进（不丢会话尺度数据）。
    const anchorCheckpoint = await storage.get_checkpoint(anchor).catch(() => null);
    const anchorSkeleton =
      anchorCheckpoint === null
        ? null
        : copySkeleton(anchorCheckpoint.state[THREAD_SKELETON_STATE_KEY]);
    const branchState: Record<string, unknown> = { input: prepared.input };
    if (anchorSkeleton !== null) branchState[THREAD_SKELETON_STATE_KEY] = anchorSkeleton;
    let result: RoundOutcome;
    try {
      const ran = await serialized((t) =>
        driveRound(runtime, params.thread_id, (transportForRun) =>
          runtime.resume_round({
            thread_id: params.thread_id,
            leaf: anchor,
            state: branchState,
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
      skeleton_carried: anchorSkeleton !== null,
      ...resultWarnings(prepared.warnings),
    };
  };

  /** 骨架 fork 试跑（P4 §4.1「可分」能力最小接线）：以源会话最新会话骨架为
   *  蓝图，把骨架复制到新线程（trial_thread_id 缺省 = 派生线程）并触发一次组装
   *  回合——主线链/骨架不动，试跑结果只观察不迁移。骨架随回合 state 显式种子
   *  携带（引擎 _seed_skeleton 优先），新线程首轮即沿蓝图推进（不组装重建）。
   *  上下文基线（消息链）复制：源会话 checkpoint 存储态的消息链经引擎投影
   *  seam（project_history_baseline：user/assistant 文本链 + 链首 system，tool
   *  产物不重放）重建后注入试跑线程首轮前——试跑上下文完整；展示态
   *  （display_messages，宿主展示流）不经此路径（不喂模型）。
   *  W7-A：fork_trial 仍属组装链入口（源骨架来自组装回合链；主线回合归档
   *  checkpoint 无骨架 = 显式 no_skeleton 拒绝），语义随退役任务重定位。 */
  const forkTrial: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asForkTrialParams(raw);
    const runtime = deps.runtime;
    const storage = runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const leaf = await storage.get_latest_checkpoint(params.thread_id).catch(() => null);
    const sourceSkeleton =
      leaf === null ? null : copySkeleton(leaf.state[THREAD_SKELETON_STATE_KEY]);
    if (sourceSkeleton === null) {
      throw new BridgeError('源会话无会话骨架可试跑（先跑组装回合建立）', 'no_skeleton');
    }
    const check = validate_skeleton_sketch(runtime, sourceSkeleton);
    if (!check.ok) {
      throw new BridgeError(
        `源会话骨架已失效（${check.reasons.join('；')}）`,
        'skeleton_invalid',
      );
    }
    const trial_thread_id =
      params.trial_thread_id ?? `${params.thread_id}:trial:${shortId('t')}`;
    const trialRoundId = shortId('r');
    // 骨架蓝图复制到试跑线程（thread_id 归位试跑线程；源骨架只读不被改写）
    const trialSkeleton = { ...sourceSkeleton, thread_id: trial_thread_id };
    const trialState: Record<string, unknown> = {
      input: params.input ?? '',
      [THREAD_SKELETON_STATE_KEY]: trialSkeleton,
    };
    // 消息基线复制：源线程历史消息链（checkpoint 存储态）→ 引擎投影 seam →
    // 注入试跑线程首轮前（试跑上下文完整：历史 user/assistant + 本次 input 收尾
    // user 消息；链首 system 随投影保留 = 试跑同基线续上下文）。仅试跑线程无
    // 既有链（首轮试跑）注入——既有试跑线程续试跑 = 引擎沿试跑链续聊
    // （_append_round_user_message 追加当轮 user），不重灌源基线。
    const existingTrial = await storage.get_latest_checkpoint(trial_thread_id).catch(() => null);
    if (leaf !== null && existingTrial === null) {
      const storedMessages = leaf.state[STATE_MESSAGES];
      const baseline = Array.isArray(storedMessages)
        ? project_history_baseline(storedMessages as never)
        : [];
      if (baseline.length > 0) {
        const chain = baseline.map((message) => message.to_dict());
        chain.push(user(params.input ?? '').to_dict());
        trialState[STATE_MESSAGES] = chain;
      }
    }
    let result: RoundOutcome;
    try {
      const ran = await serialized((t) =>
        driveRound(runtime, trial_thread_id, (transportForRun) =>
          runtime.assemble_round({
            state: trialState,
            thread_id: trial_thread_id,
            round_id: trialRoundId,
            trace_id: shortId('trace'),
            transports: [transportForRun],
          }),
          t,
        ),
      );
      result = ran.value;
    } catch (error) {
      if (error instanceof RoundAbortedError) {
        await sessions.touch(trial_thread_id, { round_id: trialRoundId, outcome: 'aborted' });
        throw new BridgeError(
          '试跑回合已中止（rounds.abort 已投递）',
          'round_aborted',
        );
      }
      throw error;
    }
    await settle(trial_thread_id, trialRoundId, result);
    return {
      thread_id: params.thread_id,
      trial_thread_id,
      round_id: trialRoundId,
      leaf: result.checkpoint_id,
      reason: result.reason,
      reply: result.state['reply'] ?? null,
      warnings: [],
    };
  };

  return {
    'rounds.send': send,
    'rounds.abort': abort,
    'rounds.resume': resume,
    'rounds.branch': branch,
    'rounds.fork_trial': forkTrial,
  };
}
