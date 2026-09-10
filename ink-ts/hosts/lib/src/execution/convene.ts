/**
 * 多协作者召集协议（collab_request 组织类工具的执行语义，设计 §7.4.1）。
 *
 * 召集 = 把「召唤协作者/子代理」的模型工具调用兑现为**子执行 + 归并契约**：
 * - 目标来源二选一（与 route/临时作用域词表同口径）：目录作用域（填目录已
 *   注册 id，装载既有身份/提示词/契约资产）或临时作用域（scope 为现场定义
 *   dict，动态创建、用完即散，不落目录）；
 * - `n` 路并行子执行走通道闸门（n=1 委托、n>1 fan-out）：资格/审批/最大并行/
 *   成本池条件由引擎 channel_gate 执行（fail-closed）；`budget` 折入各子执行
 *   护栏（max_cost 兜底线）；
 * - `mode`：blind = 各路互不可见（默认，防从众）；open = 圆桌最小形态——逐轮
 *   并行加工、后轮可见前轮全部意见（rounds 上限封顶，无新增实质意见收敛；
 *   白板共享块属会话内运行时后续形态，此处以「子执行输入投影」实现可见性）；
 * - `contract`：full = 意见全收回执（主持人裁决）；best = 确定性择优单份
 *   （引擎 pick：质量信号 > 成本 > 完成序），落选保留轨迹不入产物。
 *
 * 本模块只编排（复用 HostExecutionService 的运行时装配），归并语义复用引擎
 * fan-in（单一真源，不在宿主第二套归并实现）。
 */

import {
  CHANNEL_COMMIT_BEST,
  CHANNEL_COMMIT_FULL,
  CHANNEL_SHAPE_DELEGATE,
  CHANNEL_SHAPE_FAN_OUT,
  enforce_transition_conditions,
  fan_in_merge,
} from '@ink-ts/engine';
import type {
  ChannelCommit,
  ChannelSpec,
  ChildRunOutcome,
  ExecutionResult,
  TrailCost,
  TrailOutcome,
} from '@ink-ts/engine';

import type { HostExecutionService, RunExecutionOptions } from './service.js';
import { parse_temp_scope_def } from '@ink-ts/engine';

/** 召集声明的 n 上限（通道/护栏还会二次封顶；此常量只防畸形参数放大）。 */
export const CONVENE_MAX_N = 32;
/** open 圆桌轮次上限（护栏封顶；成本可控性优先于「永不收敛」）。 */
export const CONVENE_MAX_ROUNDS = 8;

/** 召集校验/闸门失败（执行体归一为结构化拒绝结果，不击穿回合）。 */
export class ConveneError extends Error {
  readonly reason: string;

  constructor(message: string, reason = 'invalid_params') {
    super(message);
    this.name = 'ConveneError';
    this.reason = reason;
  }
}

/** 单路子执行完成形态（召集结果投影；child 归并输入）。 */
export interface ConveneChildOutcome {
  run_id: string;
  entry_scope: string;
  outcome: TrailOutcome;
  cost: TrailCost;
  final_product: Record<string, unknown>;
  degraded: string[];
  error: string | null;
}

/** 召集产物（归并契约后的回执面；conclusion = 前台可见摘要文本）。 */
export interface ConveneResult {
  ok: true;
  scope_ref: string;
  scope_source: 'directory' | 'temp';
  mode: 'blind' | 'open';
  contract: ChannelCommit;
  n: number;
  channel: string;
  rounds_run: number;
  children: ConveneChildOutcome[];
  merged: Record<string, unknown>;
  conclusion: string;
  degraded: string[];
}

interface ConveneTarget {
  source: 'directory' | 'temp';
  /** 目录作用域 id（source=directory）。 */
  scope_id: string | null;
  /** 临时作用域定义（source=temp，已 parse 校验）。 */
  temp_def: Record<string, unknown> | null;
  /** 判定/展示引用（目录 id 或 temp:<role>）。 */
  ref: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 目标解析：entity_id（目录 id）优先；scope 字符串 = 目录 id；scope dict = 现场定义。 */
export function resolve_convene_target(args: Record<string, unknown>): ConveneTarget {
  const entity_id = args['entity_id'];
  if (typeof entity_id === 'string' && entity_id.trim() !== '') {
    return { source: 'directory', scope_id: entity_id.trim(), temp_def: null, ref: entity_id.trim() };
  }
  const scope = args['scope'];
  if (typeof scope === 'string' && scope.trim() !== '') {
    return { source: 'directory', scope_id: scope.trim(), temp_def: null, ref: scope.trim() };
  }
  if (isRecord(scope)) {
    let def: unknown;
    try {
      def = parse_temp_scope_def(scope);
    } catch (error) {
      throw new ConveneError(
        `临时作用域定义非法: ${error instanceof Error ? error.message : String(error)}`,
        'temp_scope_invalid',
      );
    }
    const role = (def as { role?: string }).role ?? '';
    return { source: 'temp', scope_id: null, temp_def: scope, ref: `temp:${role}` };
  }
  throw new ConveneError(
    '缺召集目标：entity_id（目录作用域 id）或 scope（目录 id / 临时作用域定义 dict）二选一',
  );
}

/** 参数归一（n/mode/contract/rounds/budget 缺省与取值域；非法显式拒绝）。 */
export function normalize_convene_params(args: Record<string, unknown>): {
  task: string;
  n: number;
  mode: 'blind' | 'open';
  contract: ChannelCommit;
  rounds: number;
  budget: number | null;
} {
  const task = args['task'];
  if (typeof task !== 'string' || task.trim() === '') {
    throw new ConveneError('召集缺 task（子任务描述，非空字符串）');
  }
  const rawN = args['n'] ?? 1;
  if (typeof rawN !== 'number' || !Number.isInteger(rawN) || rawN < 1 || rawN > CONVENE_MAX_N) {
    throw new ConveneError(`n 须为 1..${CONVENE_MAX_N} 的整数`);
  }
  const rawMode = args['mode'] ?? 'blind';
  if (rawMode !== 'blind' && rawMode !== 'open') {
    throw new ConveneError("mode 须为 'blind' | 'open'");
  }
  const rawContract = args['contract'] ?? CHANNEL_COMMIT_FULL;
  if (rawContract !== CHANNEL_COMMIT_FULL && rawContract !== CHANNEL_COMMIT_BEST) {
    throw new ConveneError("contract 须为 'full' | 'best'（召集契约；decision_only 属隔离试跑）");
  }
  const rawRounds = args['rounds'] ?? (rawMode === 'open' ? 2 : 1);
  if (typeof rawRounds !== 'number' || !Number.isInteger(rawRounds) || rawRounds < 1 || rawRounds > CONVENE_MAX_ROUNDS) {
    throw new ConveneError(`rounds 须为 1..${CONVENE_MAX_ROUNDS} 的整数`);
  }
  let budget: number | null = null;
  if (args['budget'] !== undefined && args['budget'] !== null) {
    if (typeof args['budget'] !== 'number' || !Number.isFinite(args['budget']) || args['budget'] < 0) {
      throw new ConveneError('budget 须为非负数');
    }
    budget = args['budget'] as number;
  }
  return {
    task: task.trim(),
    n: rawN,
    mode: rawMode,
    contract: rawContract,
    rounds: rawRounds,
    budget,
  };
}

/** 子执行结果 → convene 子完成形态 + 引擎归并输入（ChildRunOutcome 同构）。 */
function outcome_from(result: ExecutionResult): {
  child: ConveneChildOutcome;
  asMergeInput: ChildRunOutcome;
} {
  const root = result.root;
  const degraded = [...root.degraded_summaries];
  if (result.blocked && result.block_reason !== null) degraded.push(result.block_reason);
  const child: ConveneChildOutcome = {
    run_id: root.run_id,
    entry_scope: root.entry_scope,
    outcome: root.outcome,
    cost: root.cost,
    final_product: result.final_product,
    degraded,
    error: root.error,
  };
  const asMergeInput: ChildRunOutcome = {
    run_id: root.run_id,
    parent_run_id: root.parent_run_id,
    entry_scope: root.entry_scope,
    outcome: root.outcome,
    payload: result.final_product,
    summary: degraded.join('；') || null,
    cost: root.cost,
    error: root.error,
  };
  return { child, asMergeInput };
}

/** 单路意见文本投影（conclusion 前台可见面：契约字段优先，回落 JSON）。 */
function opinion_text(payload: Record<string, unknown>): string {
  for (const key of ['opinion', 'reply', 'message', 'answer', 'plan']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const rendered = JSON.stringify(payload);
  return rendered === '{}' ? '' : rendered;
}

/** 召集入口（collab_request 执行体与后续桥命令共用的组织执行语义）。 */
export async function convene(
  service: HostExecutionService,
  args: Record<string, unknown>,
  options: RunExecutionOptions = {},
): Promise<ConveneResult> {
  const target = resolve_convene_target(args);
  const params = normalize_convene_params(args);
  if (params.mode === 'blind' && args['rounds'] === undefined) params.rounds = 1;
  // 目录作用域预检（未注册/已下架 = fail-closed，不产半成品子执行、不过闸门）
  if (target.source === 'directory' && !service.hasScope(target.scope_id as string)) {
    throw new ConveneError(`目录作用域不可装载: ${target.ref}`, 'scope_unavailable');
  }

  const channel_id = params.n > 1 ? CHANNEL_SHAPE_FAN_OUT : CHANNEL_SHAPE_DELEGATE;
  const channel: ChannelSpec | null = service.channels.get(channel_id);
  if (channel === null || channel.disabled) {
    throw new ConveneError(`召集通道不可用: ${channel_id}`, 'channel_unavailable');
  }
  const gateBlock = await enforce_transition_conditions(
    channel,
    { currentScope: 'main', accumulated_cost: 0, cost_increment: 0 },
    params.n,
    service.approvalSeam(options.pose, 'collab_request'),
  );
  if (gateBlock !== null) {
    throw new ConveneError(gateBlock.message, gateBlock.reason);
  }

  const guardrailOverride = params.budget !== null ? { max_cost: params.budget } : null;
  const children: ConveneChildOutcome[] = [];
  const mergeInputs: ChildRunOutcome[] = [];
  let rounds_run = 0;
  let previous_opinions: string[] | null = null;

  const spawn_round = async (shared_view: string[] | null): Promise<void> => {
    const spawned: Promise<ExecutionResult>[] = [];
    for (let i = 0; i < params.n; i++) {
      const seq = service.nextSequence();
      const request = {
        task: params.task,
        trigger: null,
        seed_payload:
          shared_view !== null && shared_view.length > 0
            ? { round_view: shared_view.slice(), round: rounds_run + 1 }
            : undefined,
        run_id: `collab:${seq}:${i + 1}`,
        ...(target.source === 'directory'
          ? { entry_scope: target.scope_id as string }
          : { entry_temp_scope: target.temp_def as Record<string, unknown> }),
      };
      spawned.push(service.runExecution(request, { ...options, guardrails: guardrailOverride }));
    }
    const results = await Promise.all(spawned);
    for (const result of results) {
      const { child, asMergeInput } = outcome_from(result);
      children.push(child);
      mergeInputs.push(asMergeInput);
    }
  };

  // 目录作用域预检（未注册/已下架 = fail-closed，不产半成品子执行）
  if (target.source === 'directory' && !service.hasScope(target.scope_id as string)) {
    throw new ConveneError(`目录作用域不可装载: ${target.ref}`, 'scope_unavailable');
  }

  if (params.mode === 'blind') {
    await spawn_round(null);
    rounds_run = 1;
  } else {
    // open 圆桌最小形态：逐轮并行、后轮输入带此前全部意见文本；轮间无新增
    // 实质意见（投影全等）= 收敛提前终止；rounds 上限封顶成本
    for (let r = 0; r < params.rounds; r++) {
      const before = children.length;
      await spawn_round(previous_opinions);
      rounds_run += 1;
      const texts = children.slice(before).map((c) => opinion_text(c.final_product));
      if (previous_opinions !== null && JSON.stringify(texts) === JSON.stringify(previous_opinions)) {
        break;
      }
      previous_opinions = [...(previous_opinions ?? []), ...texts];
    }
  }

  const merged = fan_in_merge(mergeInputs, params.contract);
  const degraded: string[] = merged.degraded_summaries;
  const product: Record<string, unknown> = {
    contract: params.contract,
    scope: target.ref,
    mode: params.mode,
    adopted: merged.adopted.map((c) => c.payload),
    losers: merged.losers.map((c) => c.run_id),
    degraded,
  };
  if (merged.decision !== null) product['decision'] = merged.decision;
  const conclusion = merged.adopted
    .map((c) => opinion_text(c.payload))
    .filter((text) => text !== '')
    .join('\n');
  return {
    ok: true,
    scope_ref: target.ref,
    scope_source: target.source,
    mode: params.mode,
    contract: params.contract,
    n: params.n,
    channel: channel_id,
    rounds_run,
    children,
    merged: product,
    conclusion: conclusion === '' ? '（协作者无有效意见产出）' : conclusion,
    degraded,
  };
}
