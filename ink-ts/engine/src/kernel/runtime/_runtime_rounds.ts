// gate: 超限(390 行) - run 级组装回合入口（组装/选路/事件/恢复重建同文件保证与 rounds 桥语义一致，拆文件破坏装配时序可读性）
/**
 * run 级组装回合入口（A2：引擎/宿主不再依赖"默认图"）。
 *
 * 回合 = 从数据组装出本轮图再执行：assemble_round 把 input/域转成
 * AssemblyRequest → 挂载的组装运行期出候选 → 评分顶选 → 以选中图定义构建
 * 本轮 Engine（数据图 dict 装载 + A1 bound seams + run options 同源装配清单，
 * 见 _runtime_engine._build_graph_engine）→ ainvoke 执行。本轮图定义随 state
 * 保留键（_round_graph）落 checkpoint（存储 schema 不动，最小侵入 = state
 * 通道），恢复/分支按 checkpoint 关联图重建。
 *
 * 事件面：turn_started/assembly_started/assembly_done/assembly_candidate/
 * execution_started 由回合入口按现有事件类型发射（走本轮 Engine 的 publish
 * 通道：落执行日志 + 全传输；engine.emit_timeline_events=false 避免数据图
 * 引擎重复发射组装标记）。
 */

import { EngineEvent, type EngineTransport } from '../../core/events/events.js';
import type { Engine } from '../executor/index.js';
import type { RunResult } from '../../core/run_result/run_result.js';
import type { CheckpointRecord } from '../../core/storage/storage_records.js';
import type { JsonRecord } from '../../core/json.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import { SchemaField, SchemaSpec, FIELD_STRING } from '../../core/schema/schemaValidator.js';
import { AssemblyRequest } from '../path_assembler/index.js';
import { Attachment, user } from '../llm/messages.js';
import { MetaTuner, TunableParams } from '../tuning/index.js';
import { STATE_MESSAGES, TYPE_LLM_DECIDER, clamp_tool_rounds } from '../../core/nodes/constants.js';
import { RuntimeAssemble } from './_runtime_assemble.js';
import { RuntimeState } from './_types.js';

/** 本轮图定义随 checkpoint state 落库的保留键（恢复重建的关联图定义）。 */
export const ROUND_GRAPH_STATE_KEY = '_round_graph';

/** 组装请求目标字段（base 域模板由 llm_decider 产出 reply；终态 = 出口）。 */
const ROUND_GOAL_FIELDS = ['reply'] as const;

/** 回合候选数上限兜底（调参条目缺失/无知识集时的引擎当前常量）。 */
const _ROUND_TOP_K_DEFAULT = 8;
/** 调参 divergence_width → 候选数消费的钳制区间。 */
const _TUNED_TOP_K_MAX = 64;

/** run 级组装回合选项。 */
export interface RoundAssembleOptions {
  state: Record<string, unknown>;
  thread_id: string;
  round_id?: string | null;
  trace_id?: string | null;
  domain?: string | null;
  llm?: AsyncLLM | null;
  transports?: EngineTransport[] | null;
  /** 工具回合上限覆写（声明 → 组装图 llm_decider 节点 config；null/缺省 =
   *  引擎常量缺省。恢复/分支按 checkpoint 关联图续跑不经本覆写）。 */
  max_tool_rounds?: number | null;
}

/** 组装候选事件发射上限（候选过多只发前 N 条留痕，防事件文件膨胀）。 */
const _CANDIDATE_EVENT_LIMIT = 8;

/** 组装请求的域目标字段（reply；与 A1 池种子 base 模板产出对齐）。 */
function _round_goal_schema(): SchemaSpec {
  return new SchemaSpec({
    name: 'round.assembly.goal',
    fields: [...ROUND_GOAL_FIELDS].map(
      (name) => new SchemaField({ name, required: true, kind: FIELD_STRING }),
    ),
  });
}

/** 组装请求构造（域解析 seam：缺省 general；候选数 = 调参 divergence_width
 *  消费点——探索宽度/候选数语义对齐，缺省 = 引擎常量 8）。 */
function _round_request(
  domain: string | null | undefined,
  tuned: TunableParams | null,
): AssemblyRequest {
  const width = tuned === null ? _ROUND_TOP_K_DEFAULT : Math.trunc(tuned.divergence_width);
  const top_k = Math.max(1, Math.min(Number.isFinite(width) ? width : _ROUND_TOP_K_DEFAULT, _TUNED_TOP_K_MAX));
  return new AssemblyRequest({
    goal_schema: _round_goal_schema(),
    entry_fields: [],
    domain: typeof domain === 'string' && domain !== '' ? domain : 'general',
    top_k,
  });
}

/** 组装出的本轮图数据 → llm_decider 节点 config 注入回合上限（cap 语义 =
 *  clamp_tool_rounds；仅覆写 llm_decider 型节点，其余节点/图数据原样保留）。 */
function _apply_max_tool_rounds(
  graphData: Record<string, unknown>,
  max_tool_rounds: number | null | undefined,
): void {
  if (max_tool_rounds === null || max_tool_rounds === undefined) return;
  const cap = clamp_tool_rounds(max_tool_rounds);
  const rawNodes = graphData['nodes'];
  if (typeof rawNodes !== 'object' || rawNodes === null || Array.isArray(rawNodes)) return;
  for (const spec of Object.values(rawNodes as Record<string, unknown>)) {
    if (typeof spec !== 'object' || spec === null) continue;
    const node = spec as Record<string, unknown>;
    if (node['type'] !== TYPE_LLM_DECIDER) continue;
    const config = node['config'];
    if (typeof config !== 'object' || config === null || Array.isArray(config)) continue;
    node['config'] = { ...(config as Record<string, unknown>), max_tool_rounds: cap };
  }
}

/** 归一会话附件载荷为引擎 Attachment（数据面 dict 直构；非法跳过）。 */
function _round_attachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    try {
      out.push(Attachment.from_dict(item as Record<string, unknown> as never));
    } catch {
      // 非法附件载荷跳过（与 llm_decider 同兜底语义）
    }
  }
  return out;
}

/** run 级组装回合基座（RuntimeAssemble 之上的叶层；Runtime 直接继承）。 */
export abstract class RuntimeRounds extends RuntimeAssemble {
  /** 取 checkpoint 关联的本轮图定义（随 state 落库；无 = null）。 */
  _graph_from_checkpoint(checkpoint: CheckpointRecord | null): Record<string, unknown> | null {
    if (checkpoint === null) return null;
    const graph = checkpoint.state[ROUND_GRAPH_STATE_KEY];
    if (graph === null || graph === undefined || typeof graph !== 'object' || Array.isArray(graph)) {
      return null;
    }
    return graph as Record<string, unknown>;
  }

  /** 按 checkpoint 关联图定义重建本轮 Engine（digest 自洽才放行）。
   *  图定义缺失 = 旧链（图未随 checkpoint 落库）→ 返回 null（无法按图重建，
   *  调用方显式报错，不回落任何静态引擎）。 */
  protected async _engine_for_checkpoint(
    checkpoint: CheckpointRecord,
    opts: { llm?: AsyncLLM | null; domain?: string | null } = {},
  ): Promise<Engine | null> {
    const graphData = this._graph_from_checkpoint(checkpoint);
    if (graphData === null) return null;
    const engine = await this._build_graph_engine(graphData, {
      llm: opts.llm,
      domain: opts.domain,
    });
    // 恢复/分支引擎同样消费调参 retry_budget 旋钮（重入后执行器重试语义一致）
    engine.options.max_node_retries = this.assembly_round_retries(this._load_tuned());
    // digest 自洽校验：checkpoint 落库的 graph_version 与重建图 digest 一致，
    // 否则报错引导（图定义损坏/被改写 = 恢复语义不保证，拒绝续跑）
    if (checkpoint.graph_version !== null && checkpoint.graph_version !== '') {
      const digest = engine.graph.digest();
      if (digest !== checkpoint.graph_version) {
        throw new Error(
          `checkpoint 关联图定义与其 graph_version 不一致（${checkpoint.graph_version.slice(0, 12)}…` +
            ` vs 重建 ${digest.slice(0, 12)}…）：图定义损坏，无法恢复，请重新发起回合`,
        );
      }
    }
    return engine;
  }

  /** 组装时间线事件开关（配方 emit_timeline_events / run_options 覆写）。 */
  protected _round_timeline_enabled(): boolean {
    const recipe = this._recipe;
    if (recipe === null) return false;
    if (recipe.emit_timeline_events) return true;
    const runOptions = recipe.run_options as { emit_timeline_events?: unknown } | null;
    return runOptions?.emit_timeline_events === true;
  }

  /** 调参产物读取（知识集 kind=weight 条目；缺失/损坏 = 引擎缺省参数）。
   *  消费路径 = 每轮回合入口一次，应用见 assemble_round/_engine_for_checkpoint。 */
  protected _load_tuned(): TunableParams | null {
    const ks = this.knowledge_set;
    if (ks === null) return null;
    try {
      return MetaTuner.load_params(ks);
    } catch {
      return null;
    }
  }

  /** 本轮调参旋钮留痕（set_audit append-only；回合可观测旋钮消费基线）。
   *  组装/执行侧已由 audit_sink/execute 留痕——本记录承载「调参 → 旋钮」
   *  映射的证据面（测试/诊断按 kind=round_tuning 读取）。 */
  protected _record_round_tuning(
    thread_id: string,
    round_id: string | null,
    domain: string,
    tuned: TunableParams | null,
  ): void {
    if (this.knowledge_set === null) return;
    this._mechanism_sink({
      type: 'round_tuning',
      thread_id,
      round_id,
      domain,
      divergence_width: tuned?.divergence_width ?? 3,
      top_k: tuned === null ? _ROUND_TOP_K_DEFAULT
        : Math.max(1, Math.min(Math.trunc(tuned.divergence_width), _TUNED_TOP_K_MAX)),
      retry_budget: tuned?.retry_budget ?? 1,
      max_node_retries: this.assembly_round_retries(tuned),
      web_verify_threshold: tuned?.web_verify_threshold ?? 0.5,
      ts: this._r_now(),
    });
  }

  /** 调参 retry_budget → 本轮执行引擎节点重试次数（预算 = 单节点总尝试数，
   *  引擎 max_node_retries 语义 = 首次之后的额外重试；缺省预算 1 → 0 重试）。 */
  assembly_round_retries(tuned: TunableParams | null): number {
    if (tuned === null) return 0;
    return Math.max(0, Math.min(Math.trunc(tuned.retry_budget) - 1, 8));
  }

  /** 普通新回合多轮续聊：既有消息链追加当轮 user message（llm_decider 读
   *  state.messages 续上下文）。判定：仅 resume_from=null 的继续聊（assemble_
   *  round）追加；审批中断重入/分支续跑走 resume_round/resume_run（resume_from
   *  非空）不经此路径，消息链随 checkpoint 已含中断前状态——不重复注入首轮
   *  system/不追加重复 user。 */
  protected async _append_round_user_message(
    state: Record<string, unknown>,
    thread_id: string,
  ): Promise<void> {
    const storage = this.storage;
    if (storage === null) return;
    let latest: CheckpointRecord | null = null;
    try {
      latest = await storage.get_latest_checkpoint(thread_id);
    } catch {
      return;
    }
    if (latest === null) return;
    const stored = latest.state[STATE_MESSAGES];
    if (!Array.isArray(stored) || stored.length === 0) return;
    const input = String(state['input'] ?? '');
    const attachments = _round_attachments(state['attachments']);
    if (input === '' && attachments.length === 0) return;
    state[STATE_MESSAGES] = [...stored, user(input, { attachments }).to_dict()];
  }

  /** 组装事件发射（走 Engine publish：落执行日志 + 全传输；time 事件用 epoch 秒）。 */
  protected async _round_emit(
    engine: Engine,
    transports: readonly EngineTransport[],
    etype: string,
    payload: Record<string, unknown>,
    opts: { thread_id: string; round_id?: string | null; node?: string | null },
  ): Promise<void> {
    await engine._publish(
      new EngineEvent({
        type: etype,
        payload: payload as JsonRecord,
        step_id: null,
        round_id: opts.round_id ?? null,
        node: opts.node ?? null,
        thread_id: opts.thread_id,
      }),
      { transports: [...engine.options.transports, ...transports] },
    );
  }

  /**
   * run 级组装回合（rounds.send 新入口）：input/域 → 组装 → 本轮 Engine →
   * ainvoke（continue_chain）。返回 RunResult（reason/checkpoint_id/state 与
   * 现 rounds.ts 期望一致）。回合在途登记由调用方（host 队列保护）负责。
   */
  async assemble_round(opts: RoundAssembleOptions): Promise<RunResult> {
    if (this._state !== RuntimeState.RUNNING) {
      throw new Error(`运行时状态不允许发起组装回合: ${this._state}`);
    }
    const runtime = this.assembly_runtime;
    if (runtime === null || this.graph_registries === null) {
      throw new Error('组装运行期未挂载（回合=组装不可用；检查 assembler_enabled）');
    }
    const thread_id = opts.thread_id;
    const round_id = opts.round_id ?? null;
    const transports = opts.transports ?? [];
    // 调参产物每轮回合入口读一次（知识集 kind=weight → 本轮旋钮）：候选数
    // 消费点在组装请求（divergence_width），节点重试消费点在 _build_graph_engine
    // （retry_budget），旋钮留痕经 round_tuning 审计记录。
    const tuned = this._load_tuned();
    const request = _round_request(opts.domain, tuned);
    // 组装 + 候选集（canary 试跑关：round 真实执行已含验证，候选重建级校验
    // 即可；canary 门保持于显式组装预检路径）
    const assembled = await runtime.assemble_plan(request, {
      audit_sink: (record) => this._mechanism_sink(record),
      canary: false,
    });
    if (assembled.is_empty || assembled.candidates.length === 0) {
      throw new Error(
        `回合组装无候选（domain=${request.domain}）：请检查结点池/边先验/技能与目标字段`,
      );
    }
    // 评分顶选（候选已按 rank 排序；含 canary 结论时跳过未过验证者）
    const best =
      assembled.canary.length > 0
        ? assembled.candidates.find(
            (candidate, index) => assembled.canary[index]?.ok !== false,
          ) ?? assembled.candidates[0]!
        : assembled.candidates[0]!;
    const graphData = best.graph.to_dict() as Record<string, unknown>;
    // 回合上限声明注入点：host 每次回合活读能力配置 → 覆写 llm_decider 节点
    // config（随本轮图执行并落 checkpoint；恢复/分支按 checkpoint 原图续跑）
    _apply_max_tool_rounds(graphData, opts.max_tool_rounds);
    const engine = await this._build_graph_engine(graphData, {
      llm: opts.llm,
      domain: request.domain,
    });
    // 调参 retry_budget → 本轮引擎节点重试旋钮（真实消费点：executor 按
    // max_node_retries 重试节点异常）
    engine.options.max_node_retries = this.assembly_round_retries(tuned);
    this._record_round_tuning(thread_id, round_id, request.domain, tuned);
    // 回合组装时间线事件（真实组装动作 + 真实候选数据；开关对齐配方）
    if (this._round_timeline_enabled()) {
      await this._round_emit(
        engine,
        transports,
        'turn_started',
        { round_id, ts: this._r_now() },
        { thread_id, round_id },
      );
      await this._round_emit(engine, transports, 'assembly_started', { ts: this._r_now() }, { thread_id, round_id });
      for (const candidate of assembled.candidates.slice(0, _CANDIDATE_EVENT_LIMIT)) {
        const payload: Record<string, unknown> = {
          rank: candidate.rank,
          source: candidate.source,
          score: candidate.score,
          chain: [...candidate.chain],
        };
        await this._round_emit(engine, transports, 'assembly_candidate', payload, { thread_id, round_id });
      }
      await this._round_emit(engine, transports, 'assembly_done', { ts: this._r_now() }, { thread_id, round_id });
      await this._round_emit(
        engine,
        transports,
        'execution_started',
        { node: String(engine.graph.entry ?? ''), ts: this._r_now() },
        { thread_id, round_id, node: engine.graph.entry },
      );
    }
    const runState: Record<string, unknown> = { ...opts.state };
    runState[ROUND_GRAPH_STATE_KEY] = graphData;
    // 多轮续聊：resume_from=null 的普通新回合把当轮 input 追加进既有消息链
    // （llm_decider 读 state.messages 续上下文）；审批重入/分支（resume_from
    // 非空）走 resume_run/resume_round，不经本路径不追加。
    await this._append_round_user_message(runState, thread_id);
    return await engine.ainvoke(runState, {
      thread_id,
      round_id,
      continue_chain: true,
      trace_id: opts.trace_id ?? null,
      transports,
    });
  }

  /** 分支/恢复回合：按锚点 checkpoint 关联图重建本轮 Engine 并 resume_from
   *  续跑（同图语义续跑新叶；branch 输入无 domain = 沿用原图）。 */
  async resume_round(opts: {
    thread_id: string;
    leaf: number;
    state?: Record<string, unknown> | null;
    round_id?: string | null;
    trace_id?: string | null;
    llm?: AsyncLLM | null;
    transports?: EngineTransport[] | null;
  }): Promise<RunResult> {
    if (this.storage === null) {
      throw new Error('运行时未装配存储（无法恢复续跑）');
    }
    const checkpoint = await this.storage.get_checkpoint(opts.leaf);
    if (checkpoint === null) {
      throw new Error(`恢复锚点不存在: ${opts.leaf}`);
    }
    if (checkpoint.thread_id !== opts.thread_id) {
      throw new Error(`恢复锚点不属于该会话: #${opts.leaf}`);
    }
    const engine = await this._engine_for_checkpoint(checkpoint, { llm: opts.llm });
    if (engine === null) {
      throw new Error('checkpoint 无关联图定义（旧链/未落图）：恢复续跑需先发起组装回合');
    }
    const state: Record<string, unknown> = { ...(opts.state ?? {}) };
    return await engine.ainvoke(state, {
      thread_id: opts.thread_id,
      round_id: opts.round_id ?? null,
      resume_from: opts.leaf,
      trace_id: opts.trace_id ?? null,
      transports: opts.transports ?? null,
    });
  }

  /** 审批决议重入：按 checkpoint 关联图重建本轮 Engine 续跑。
   *  checkpoint 无关联图（旧链）→ 显式报错（无法按图重建）。 */
  async resume_run(
    thread_id: string,
    decision: Record<string, unknown>,
    options: { round_id?: string | null; transports?: EngineTransport[] | null } = {},
  ): Promise<unknown> {
    if (this.storage === null) {
      throw new Error('运行时未装配或存储缺失（无法决议重入）');
    }
    const latest = await this.storage.get_latest_checkpoint(thread_id);
    if (latest === null || latest.interrupt === null) {
      throw new Error('该会话无挂起审批卡');
    }
    const graphData = this._graph_from_checkpoint(latest);
    if (graphData === null) {
      throw new Error('checkpoint 无关联图定义（旧链/未落图）：决议重入需先发起组装回合');
    }
    const engine = await this._engine_for_checkpoint(latest);
    if (engine === null) {
      throw new Error('checkpoint 关联图无法重建（无法决议重入）');
    }
    const interrupt = await engine.get_latest_interrupt(thread_id);
    if (interrupt === null) {
      throw new Error('该会话无挂起审批卡');
    }
    const ticket = this.begin_run(thread_id);
    // 决议事件入账本候选（用户显式 accept/edit/reject = 确认类事实；回合
    // 收尾经账本 settle 并入事实事件集，供记忆抽取确认类条目）
    this._record_review_decision(thread_id, interrupt.key, decision);
    let result: unknown = null;
    let completed = false;
    try {
      result = await engine.ainvoke(
        {},
        {
          thread_id,
          round_id: options.round_id ?? null,
          resume_from: latest.checkpoint_id,
          inject: { [interrupt.key]: decision },
          transports: options.transports ?? null,
        },
      );
      completed = true;
      return result;
    } finally {
      this.end_run(ticket);
      if (!completed) {
        // 引擎抛错 = settle 链未触发：补记失败回合信号（正常完成 = 引擎已
        // 注入回合指标 + 收尾调参 settle 钩子处理，此处不再重复）
        this._tune_round_end(null);
      }
    }
  }
}

export type { Engine, RunResult };
