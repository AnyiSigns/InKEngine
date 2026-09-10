/**
 * 多协作者召集协议（collab_request 组织类工具的执行语义）。
 *
 * 召集 = 把「召唤协作者」的模型工具调用兑现为**白板驱动的子执行 + 裁决归并**：
 * - 目标二选一：目录作用域（entity_id / scope 字符串）或临时作用域（scope dict，
 *   现场定义、用完即散）；`n` 路并行走通道闸门（n=1 委托、n>1 fan-out，fail-closed；
 *   入口校验/参数归一见 convene_params.ts）；
 * - 白板：召集时一次性声明授权（main 全可见、fail-closed），main 写任务块
 *   广播；每路子执行经 ExecutionRequest.whiteboard 快照下发（W6A3 穿透），turn input
 *   只含被授权视图——blind 只见任务块，open 另见此前全部意见块（名册/快照细则见
 *   convene_board.ts）；
 * - blind（默认）：单轮 fan-out，意见块私有互不可见；open（圆桌）：意见块升级共享，
 *   逐轮并行、后轮经白板视图看到前轮意见，judge_round 判收敛（无新实质 / ≥k 确认 /
 *   rounds ≤ 8 触顶；不收敛不加轮——main 拍板，降级摘要可见，成本封顶）；
 * - 意见代写：子执行产物由宿主代写为意见块（owner = 席位身份，见 convene_board.ts）；
 *   W6C1 adjudicate 裁决（schema 门禁剔除记失败 + 去重 + 冲突标记 + 仲裁建议）→
 *   main 一次 turn 消费综合结构产出结论 → 写结论块（main turn 失败/无意见回落
 *   确定性投影并记降级）；
 * - 护栏：并行上限走通道 max_parallel、轮次 R 封顶、意见块 schema 校验（协作方
 *   produces 契约）、成本独立计入各子执行；白板审计随 W6A3 whiteboard_audit 事件
 *   通道透出（子执行读审计由运行时转发，宿主代写审计经同一 onEvent sink）。
 *
 * 本模块只编排（复用 HostExecutionService 装配），归并/裁决/收敛语义全复用引擎
 * （fan-in 与 core/collab 单一真源，不在宿主第二套实现）。
 */

import {
  CHANNEL_SHAPE_DELEGATE,
  CHANNEL_SHAPE_FAN_OUT,
  MAIN_SCOPE,
  USER_SCOPE,
  adjudicate,
  default_whiteboard_grants,
  enforce_transition_conditions,
  fan_in_merge,
  judge_round,
  opinions_digest,
} from '@ink-ts/engine';
import type {
  ChannelCommit,
  ChannelSpec,
  ChildRunOutcome,
  ConvergenceVerdict,
  ExecutionRequest,
  ExecutionResult,
  OpinionEntry,
  TrailCost,
  TrailOutcome,
} from '@ink-ts/engine';

import {
  ConveneBoard,
  board_roster,
  opinion_entry_of,
  opinion_text,
  scope_contract,
  seat_owner,
} from './convene_board.js';
import {
  ConveneError,
  normalize_convene_params,
  resolve_convene_target,
} from './convene_params.js';
import type { ConveneParams, ConveneTarget } from './convene_params.js';
import type { HostExecutionService, RunExecutionOptions } from './service.js';

// 公共面（hosts/lib/src/index.ts 与 collab_command.ts 取用）：参数/错误真源在
// convene_params.ts，此处透传保持既有 import 路径稳定。
export { CONVENE_MAX_N, CONVENE_MAX_ROUNDS, ConveneError, normalize_convene_params, resolve_convene_target } from './convene_params.js';
export type { ConveneTarget } from './convene_params.js';

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

  const seq = service.nextSequence();
  const nsRunId = `collab:${seq}`;
  // 召集授权声明（§7.2）：名册 = 意见块写入者席位身份全集（细则见 convene_board.ts）
  const board = new ConveneBoard(
    default_whiteboard_grants(params.mode, board_roster(target, params.n, params.rounds, seq), {
      userScope: USER_SCOPE,
    }),
    options.onEvent,
  );
  return convene_run(service, target, params, options, board, seq, nsRunId, channel_id);
}

/** 召集主流程（白板就位后的编排；拆出自 convene 保持函数单一职责）。 */
async function convene_run(
  service: HostExecutionService,
  target: ConveneTarget,
  params: ConveneParams,
  options: RunExecutionOptions,
  board: ConveneBoard,
  seq: number,
  nsRunId: string,
  channel_id: string,
): Promise<ConveneResult> {
  board.put('task', MAIN_SCOPE, params.task, nsRunId, null);
  const guardrailOverride = params.budget !== null ? { max_cost: params.budget } : null;
  const children: ConveneChildOutcome[] = [];
  const mergeInputs: ChildRunOutcome[] = [];
  const written = new Map<string, { entry: OpinionEntry; seat: number }>();
  let childIndex = 0;
  let rounds_run = 0;
  let convergence: ConvergenceVerdict | null = null;

  // 一轮 fan-out：白板当前态快照随每路子执行下发（W6A3 穿透取授权视图）；
  // 完成后代写意见块（owner = 席位身份）并回传本轮意见条目（席位序 = 并行序）。
  const spawnRound = async (): Promise<Array<{ entry: OpinionEntry; seat: number }>> => {
    const scopeModel =
      target.source === 'directory' ? service.loadScope(target.scope_id as string)?.model ?? null : null;
    const spawned: Promise<{ result: ExecutionResult; runId: string; seat: number }>[] = [];
    for (let i = 0; i < params.n; i++) {
      const runId = `collab:${seq}:${childIndex + 1}`;
      childIndex += 1;
      const request: ExecutionRequest = {
        task: params.task,
        trigger: null,
        run_id: runId,
        ...(target.source === 'directory'
          ? { entry_scope: target.scope_id as string }
          : { entry_temp_scope: target.temp_def as Record<string, unknown> }),
        whiteboard: board.childSession(target, runId, params.mode),
        whiteboard_context_window: service.resolveScopeContextWindow(scopeModel),
      };
      spawned.push(
        service.runExecution(request, { ...options, guardrails: guardrailOverride }).then((result) => ({ result, runId, seat: i })),
      );
    }
    const round: Array<{ entry: OpinionEntry; seat: number }> = [];
    for (const { result, runId, seat } of await Promise.all(spawned)) {
      const { child, asMergeInput } = outcome_from(result);
      children.push(child);
      mergeInputs.push(asMergeInput);
      if (child.outcome === 'failure') continue; // 失败子执行不产意见块（只留摘要）
      const owner = seat_owner(target, runId, seat);
      const seqNo = board.put('opinion', owner, opinion_text(child.final_product), runId, nsRunId);
      const entry = opinion_entry_of(child.final_product, owner, seqNo);
      written.set(runId, { entry, seat });
      round.push({ entry, seat });
    }
    return round;
  };
  // 收敛判据的席位稳定投影：digest 含 owner，而临时作用域每轮身份不同——前后轮
  // 一律以席位号归一后比较，「同席前后轮同文 = 无新实质」，语义与目录作用域一致；
  // 确认计数（confirmers 按去重 owner）在席位投影下与真实席位一一对应。
  const seat_entries = (round: ReadonlyArray<{ entry: OpinionEntry; seat: number }>): OpinionEntry[] =>
    round.map(({ entry, seat }) => ({ ...entry, owner: `s${seat}` }));
  const digest_of = (round: ReadonlyArray<{ entry: OpinionEntry; seat: number }>): string =>
    opinions_digest(seat_entries(round));

  if (params.mode === 'blind') {
    await spawnRound();
    rounds_run = 1;
  } else {
    let previousDigest: string | null = null;
    for (let r = 1; r <= params.rounds; r++) {
      const round = await spawnRound();
      rounds_run = r;
      const verdict = judge_round(previousDigest, seat_entries(round), {
        round: r,
        rounds_cap: params.rounds,
      });
      if (verdict.converged || verdict.reason === 'rounds_exhausted') {
        convergence = verdict;
        break;
      }
      previousDigest = digest_of(round);
    }
  }

  const merged = fan_in_merge(mergeInputs, params.contract);
  const quality: Record<string, number> = {};
  const adoptedEntries: OpinionEntry[] = [];
  for (const c of merged.adopted) {
    const meta = written.get(c.run_id);
    if (meta === undefined) continue;
    adoptedEntries.push(meta.entry);
    const q = c.payload['_quality'];
    if (typeof q === 'number' && Number.isFinite(q)) quality[meta.entry.owner] = q;
  }
  const adjudication = adjudicate(adoptedEntries, { contract: scope_contract(service, target), quality });
  const degraded: string[] = [...merged.degraded_summaries];
  if (convergence !== null && !convergence.converged) {
    degraded.push(`open 圆桌 ${rounds_run} 轮未收敛（${convergence.reason}），移交 main 拍板`);
  }

  // main 裁决 turn：全量可见白板 + 裁决综合结构（synthesis 载荷）→ 综合结论
  // （以 schema 门禁后的采纳意见为准——被剔除意见不进综合，无采纳不空跑 turn）
  let conclusion = '';
  if (adjudication.accepted.length > 0) {
    const mainTurn = await service.runExecution(
      {
        task: params.task,
        seed_payload: { collab_synthesis: adjudication.synthesis },
        run_id: `collab:${seq}:main`,
        entry_scope: 'main',
        whiteboard: board.mainSession(params.mode),
        whiteboard_context_window: service.resolveScopeContextWindow(service.loadScope('main')?.model ?? null),
      },
      { ...options, guardrails: guardrailOverride },
    );
    if (!mainTurn.blocked && mainTurn.root.outcome !== 'failure') {
      conclusion = opinion_text(mainTurn.final_product);
    } else {
      degraded.push(mainTurn.block_reason ?? mainTurn.root.error ?? 'main 裁决 turn 失败');
    }
  }
  if (conclusion === '') {
    conclusion = adjudication.accepted.map((e) => e.content).filter((t) => t !== '').join('\n');
    if (conclusion === '') conclusion = '（协作者无有效意见产出）';
  }
  board.put('conclusion', MAIN_SCOPE, conclusion, nsRunId, null);
  if (degraded.length > 0) board.put('summary', MAIN_SCOPE, degraded.join('；'), nsRunId, null);

  const product: Record<string, unknown> = {
    contract: params.contract,
    scope: target.ref,
    mode: params.mode,
    adopted: merged.adopted.map((c) => c.payload),
    losers: merged.losers.map((c) => c.run_id),
    degraded,
    points: adjudication.synthesis.points,
    conflicts: adjudication.synthesis.conflicts,
    rejected: adjudication.synthesis.rejected,
  };
  if (merged.decision !== null) product['decision'] = merged.decision;
  if (convergence !== null) {
    product['convergence'] = { converged: convergence.converged, reason: convergence.reason };
  }
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
    conclusion,
    degraded,
  };
}
