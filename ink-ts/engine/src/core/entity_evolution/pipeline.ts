// gate: 超限(365 行) - 实体演化管线单一闭环（观察→蒸馏→闸门→替换→晋升），拆文件即破坏状态流
/**
 * 实体演化闭环（entity_evolution.py EntityEvolutionPipeline 移植）：回合
 * 事件 → 实体失败信号缓冲 → 按需变异 → 三层闸门 → 严格更优替换 → 晋升。
 * 同一实例同时实现 EngineTransport（观察回合事件流）与 settle 钩子（回合
 * 收尾触发），由 Runtime 装配注入。故障隔离：观察/触发吞异常（不阻断 run
 * 交付）；emit 未注入 = 静默。core 零 IO：不落日志（Python logger.warning
 * 留痕为可观测性副作用）。文件拆分：观察侧 _observe.ts、蒸馏 _mutation.ts、
 * 事件负载 _util.ts，本文件承载管线状态与触发/落位/晋升/诊断。
 */

import { EntityRegistry, EntitySpec } from '../entities/entities.js';
import type { EngineEvent } from '../events/events.js';
import type { EvolutionWriter } from '../evolution_writer/_types.js';
import { SignalClassifier } from '../knowledge_signals/signals.js';
import type { ExecutionSignal } from '../knowledge_signals/signals.js';
import {
  LEVEL_PROJECT,
  LEVEL_USER,
  LEVEL_WORK,
} from '../knowledge_set/index.js';
import { EntityEvolutionConfig, EntityMutationResult, _LEVEL_ORDER } from './_types.js';
import type { EntityEvolutionConfigOptions } from './_types.js';
import {
  _evolution_level,
  _now,
  as_dict,
  as_list,
  distill_outcome_payload,
  entity_mutated_payload,
  entity_promoted_payload,
  gate_verdict_payload,
  signal_detected_payload,
  to_int,
} from './_util.js';
import { _derive_mutation } from './_mutation.js';
import { _observe } from './_observe.js';
import { EntityMutationGate } from './gate.js';
/** LLM 精修变异回调（可选扩展：(entity, signals) -> 声明 dict | null；
 *  null/缺省 = 确定性基线——失败信号蒸馏为教训块追加 persona）。 */
export type EntityMutateFn = (
  spec: EntitySpec,
  signals: readonly ExecutionSignal[],
) => Record<string, unknown> | null;

/** 演化事件发射回调（注入引擎事件流；未注入 = 静默）。 */
export type EntityEmitFn = (
  etype: string,
  payload: Record<string, unknown>,
) => unknown;
/** EntityEvolutionPipeline 构造选项（镜像 Python kw-only 参数）。 */
export interface EntityEvolutionPipelineOptions {
  config?: EntityEvolutionConfigOptions | EntityEvolutionConfig | null;
  mutate?: EntityMutateFn | null;
  emit?: EntityEmitFn | null;
}
/** 实体演化闭环：失败信号缓冲 → 变异 → 三层闸门 → 严格更优替换 → 晋升。 */
export class EntityEvolutionPipeline {
  readonly config: EntityEvolutionConfig;
  readonly registry: EntityRegistry;
  readonly writer: EvolutionWriter | null;
  readonly _classifier = new SignalClassifier();
  readonly _gate = new EntityMutationGate();
  // 实体 → 孵化缓冲（跨回合累积；变异后清空）
  _entity_signals = new Map<string, ExecutionSignal[]>();
  // 待发射的信号检测队列（观察侧只入队，回合收尾 settle 锁外批量发射——
  // 避免在引擎传输锁内重入 publish 死锁）
  _pending_signal_events: ExecutionSignal[] = [];
  // collab_request 调用归因记忆（tool_call_id → entity_id；tool_end 消费即
  // 弹出，防止映射无界增长）
  _collab_calls = new Map<string, string>();
  // 干净回合计数（变异后实体进入计数；零失败递增，归因失败清零）
  _clean_rounds = new Map<string, number>();
  // 诊断计数（只读快照的数据面）
  collected_total = 0; // 累计收集实体关联信号数
  mutation_attempts = 0; // 变异尝试次数
  mutation_passed = 0; // 变异过闸落位数
  mutation_rejected = 0; // 变异未过闸/无新教训数
  promotions = 0; // 晋升次数
  last_flush_note = '实体演化管线就绪（默认开启，回合收尾按需变异）';
  _last_mutated_at: number | null = null;
  private _mutate: EntityMutateFn | null;
  private _emit: EntityEmitFn | null;

  constructor(
    registry: EntityRegistry,
    writer: EvolutionWriter | null = null,
    options: EntityEvolutionPipelineOptions = {},
  ) {
    this.config =
      options.config instanceof EntityEvolutionConfig
        ? options.config
        : new EntityEvolutionConfig(options.config ?? {});
    this.registry = registry;
    this.writer = writer;
    this._mutate = options.mutate ?? null;
    this._emit = options.emit ?? null;
  }

  /** 注入事件发射回调（引擎装配后接引擎事件流；null = 静默）。 */
  set_emit(emit: EntityEmitFn | null): void {
    this._emit = emit;
  }

  // ── 事件发射（演化动态 → 前端演化页签）──
  /** 发射演化事件（注入回调转发；异常忽略——观测不阻断演化）。 */
  private async _publish(
    etype: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this._emit === null) return;
    try {
      await this._emit(etype, payload);
    } catch {
      // 实体演化事件发射失败（忽略）
    }
  }

  // ── 观察侧：回合事件 → 实体关联失败信号 ──
  /** EngineTransport：观察回合事件流（观测不阻断执行）。 */
  async send(event: EngineEvent): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await _observe(this, event);
    } catch {
      // 实体演化管线事件观察失败（忽略）
    }
  }

  // ── 触发侧：回合收尾按需变异 + 晋升判定 ──
  /** SettleHook：回合收尾（实体变异 + 晋升判定；异常忽略）。 */
  async settle(_ctx: unknown): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.flush_round();
    } catch {
      // 实体演化管线回合收尾失败（忽略）
    }
  }

  /** 回合收尾刷新：缓冲信号按实体变异 → 三层闸门 → 落位 + 晋升。 */
  async flush_round(): Promise<void> {
    const pending = this._pending_signal_events;
    this._pending_signal_events = [];
    for (const signal of pending) {
      await this._publish('signal_detected', signal_detected_payload(signal));
    }
    const failedThisRound = new Set<string>();
    for (const signal of pending) {
      const raw = signal.context['entity_id'];
      if (typeof raw === 'string') failedThisRound.add(raw);
    }
    for (const entityId of [...this._clean_rounds.keys()]) {
      if (
        !failedThisRound.has(entityId) &&
        this.registry.names().includes(entityId)
      ) {
        this._clean_rounds.set(
          entityId,
          (this._clean_rounds.get(entityId) ?? 0) + 1,
        );
      } else {
        this._clean_rounds.delete(entityId);
      }
    }
    for (const entityId of [...failedThisRound].sort()) {
      await this._try_mutate(entityId);
    }
    for (const entityId of [...this._clean_rounds.keys()]) {
      if (
        (this._clean_rounds.get(entityId) ?? 0) >=
        this.config.promotion_rounds
      ) {
        await this._try_promote(entityId);
      }
    }
  }

  // ── 变异侧：失败信号 → 变异声明（确定性基线 _derive_mutation）──
  /** 尝试变异单实体（缓冲不足/无新教训/未过闸 = 不变异）。 */
  private async _try_mutate(entity_id: string): Promise<boolean> {
    const signals = this._entity_signals.get(entity_id) ?? [];
    if (signals.length < this.config.mutate_threshold) return false;
    const spec = this.registry.get(entity_id);
    if (spec === null) {
      // 实体已废弃：清缓冲（归因到已删除实体不演化）
      this._entity_signals.delete(entity_id);
      return false;
    }
    let result: EntityMutationResult | null;
    if (this._mutate !== null) {
      const mutation = this._mutate(spec, signals);
      result =
        mutation !== null &&
        typeof mutation === 'object' &&
        !Array.isArray(mutation)
          ? new EntityMutationResult({
              spec: EntitySpec.from_dict(mutation),
              new_lessons: 0,
            })
          : null;
    } else {
      result = _derive_mutation(spec, signals);
    }
    this.mutation_attempts += 1;
    if (result === null) {
      this.mutation_rejected += 1;
      this._entity_signals.delete(entity_id);
      this.last_flush_note = `实体 ${entity_id}: 无新教训（同因去重，不变异）`;
      return false;
    }
    const old_coverage = to_int(
      as_dict(spec.meta['evolution'])['addressed_count'],
    );
    const new_coverage = old_coverage + result.new_lessons;
    const lessonText = as_list(as_dict(result.spec.meta['evolution'])['lessons'])
      .map((item) => String(as_dict(item)['text'] ?? ''))
      .join('\n');
    const anchor = signals[0]!;
    await this._publish(
      'distill_outcome',
      distill_outcome_payload(anchor, lessonText),
    );
    const [l1, l2, l3] = await this._gate.check(result.spec, spec, {
      new_coverage,
      old_coverage,
      lesson_text: lessonText,
    });
    this._entity_signals.delete(entity_id);
    if (l1.passed && l2.passed && l3.passed) {
      if (await this._apply_mutation(entity_id, result.spec)) {
        this.mutation_passed += 1;
        this._clean_rounds.set(entity_id, 0);
        this._last_mutated_at = _now();
        const version = to_int(
          as_dict(result.spec.meta['evolution'])['version'],
        );
        this.last_flush_note = `实体 ${entity_id} 变异过闸落位（version ${version}）`;
        await this._publish(
          'gate_verdict',
          gate_verdict_payload(anchor, true, l3.reason),
        );
        await this._publish('entity_mutated', entity_mutated_payload(result.spec));
        return true;
      }
      this.mutation_rejected += 1;
      this.last_flush_note = `实体 ${entity_id} 变异落位失败（写入未生效，不变更）`;
      return false;
    }
    this.mutation_rejected += 1;
    this.last_flush_note = `实体 ${entity_id} 变异未过闸（${l3.reason}）`;
    await this._publish(
      'gate_verdict',
      gate_verdict_payload(anchor, false, l3.reason),
    );
    return false;
  }

  /** 变异落位：演化写入管线（补丁链+实时写+审计）+ 注册表换入。
   *  无写入器（writer=null，测试/无存储态）= 仅注册表内存态换入。 */
  private async _apply_mutation(
    entity_id: string,
    spec: EntitySpec,
  ): Promise<boolean> {
    try {
      if (this.writer !== null) {
        await this.writer.write(
          this.registry.collection,
          entity_id,
          spec.to_dict(),
          {
            kind: 'entity',
            asset_id: entity_id,
            note: `实体演化：失败信号驱动变异（version ${to_int(
              as_dict(spec.meta['evolution'])['version'],
            )}）`,
          },
        );
      }
      this.registry.replace(spec);
      return true;
    } catch {
      // 实体变异落位失败（跳过）
      return false;
    }
  }

  // ── 晋升侧：变异后连续 N 回合零失败 → 层级晋升 ──
  /** 晋升尝试：变异后稳定（连续零失败）→ 工作 → 项目 → 用户。 */
  private async _try_promote(entity_id: string): Promise<void> {
    if (this.writer === null) return;
    const spec = this.registry.get(entity_id);
    if (spec === null) {
      this._clean_rounds.delete(entity_id);
      return;
    }
    const evolved = as_dict(spec.meta['evolution']);
    const level = _evolution_level(evolved['level']);
    if (level === LEVEL_USER) {
      this._clean_rounds.delete(entity_id);
      return;
    }
    if ((_LEVEL_ORDER[level] ?? 0) >= _LEVEL_ORDER[LEVEL_USER]!) return;
    const next_level = level === LEVEL_WORK ? LEVEL_PROJECT : LEVEL_USER;
    const newMeta = { ...spec.meta };
    newMeta['evolution'] = { ...evolved, level: next_level };
    const upgraded = new EntitySpec({
      id: spec.id,
      label: spec.label,
      persona: spec.persona,
      model: spec.model,
      meta: newMeta,
    });
    try {
      await this.writer.write(
        this.registry.collection,
        entity_id,
        upgraded.to_dict(),
        {
          kind: 'entity',
          asset_id: entity_id,
          note: `实体晋升：${level} → ${next_level}`,
        },
      );
    } catch {
      // 实体晋升写入失败（跳过）
      return;
    }
    this.registry.replace(upgraded);
    this.promotions += 1;
    this._clean_rounds.delete(entity_id);
    this.last_flush_note =
      `实体 ${entity_id} 晋升 ${next_level}` +
      `（连续 ${this.config.promotion_rounds} 回合零失败）`;
    await this._publish('entity_promoted', entity_promoted_payload(upgraded, level));
  }

  // ── 诊断侧：只读快照 ──
  /** 演化状态只读快照（各实体演化态 + 全局计数，无可操作项）。 */
  snapshot(): Record<string, unknown> {
    const entities: Record<string, Record<string, unknown>> = {};
    for (const entity_id of [...this.registry.names()].sort()) {
      const spec = this.registry.get(entity_id);
      const evolved = spec !== null ? as_dict(spec.meta['evolution']) : {};
      entities[entity_id] = {
        level: _evolution_level(evolved['level']),
        version: to_int(evolved['version']),
        lessons: as_list(evolved['lessons']).length,
        clean_rounds: this._clean_rounds.get(entity_id) ?? 0,
        incubating_signals: (this._entity_signals.get(entity_id) ?? []).length,
      };
    }
    return {
      enabled: this.config.enabled,
      collected_total: this.collected_total,
      mutation_attempts: this.mutation_attempts,
      mutation_passed: this.mutation_passed,
      mutation_rejected: this.mutation_rejected,
      promotions: this.promotions,
      entities,
      last_flush_note: this.last_flush_note,
    };
  }
}
