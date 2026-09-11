/**
 * 自学习族装配层（D04/D05 接线）：回合记忆抽取、技能容器、离线进化调度
 * 与回合收尾调参。
 *
 * - 记忆：回合收尾把当轮账本事实（意图/结论 + 用户决议确认事件）规则抽取
 *   入用户级 memory 域（StorageBackedMemoryStore = EvolutionWriter
 *   kind=memory 受控通道），settle 钩子按 thread+round 幂等（同 round
 *   不重复抽取）；
 * - 技能容器：KnowledgeSkillStore = 知识集 kind=path 条目访问器（知识集
 *   补丁链 = 唯一演化史）；结晶自动触发源（指纹缓存命中）已随组装链路
 *   退役，容器与互转保持，观察侧 skill_crystallizer 恒空；
 * - 进化调度：evolution 工厂（离线变异-择优）的产品内入口
 *   runtime.evolve_offline——宿主显式调用（默认保守：无回合内自动调度，
 *   不引入每回合开销）；闸门/样例由调用方注入（领域 fixtures 属宿主）；
 * - 收尾调参：普通回合收尾经 settle 钩子接入 MetaTuner，回合指标由引擎
 *   注入 RunOptions.metrics 聚合一次。
 *
 * 沉淀链顺序（super 基础链 …归因/账本之后）：记忆抽取 → growth → 实体演化
 * → 收尾调参 → 决议事件边界清理。
 */

import { EvolutionFactory } from '../evolution/index.js';
import type { EvolutionGate } from '../evolution/index.js';
import type { KnowledgeEntry } from '../../core/knowledge_set/index.js';
import type { KnowledgeSet } from '../../core/knowledge_set/index.js';
import { StorageBackedMemoryStore } from '../../core/memory/index.js';
import {
  DEFAULT_NAMESPACE,
  MemoryExtractSettleHook,
} from '../memory_extract/index.js';
import type { SettleContext, SettleHooks } from '../settle/index.js';
import { KnowledgeSkillStore } from '../skill_crystal/index.js';
import type { Storage } from '../../core/storage/storage.js';
import { MetaTuner } from '../tuning/index.js';
import type { TunableParams, TurnMetrics } from '../tuning/index.js';
import type { AssemblyRecipe } from './_types.js';
import { _round_ledger_facts } from './_settle.js';
import { RuntimeRebuild } from './_runtime_engine.js';

/** 记忆存储集合名（records 通道普通命名空间；写入经 EvolutionWriter 管线）。 */
const _MEMORY_COLLECTION = 'memory';

/** 回合收尾调参钩子的运行时访问面（结构契约）。 */
interface _TuneRuntimeLike {
  meta_tuner: {
    tune_persisted(
      params: TunableParams,
      metrics: TurnMetrics,
      options?: { feedback?: Readonly<Record<string, number>> | null; rule_version?: string | null },
    ): unknown;
  } | null;
  turn_metrics: TurnMetrics | null;
  knowledge_set: KnowledgeSet | null;
}

/** 回合收尾调参 settle 钩子（引擎已注入指标聚合——本钩子只读指标不重复记录）。 */
class _RoundTuneSettleHook {
  readonly #rt: _TuneRuntimeLike;

  constructor(rt: _TuneRuntimeLike) {
    this.#rt = rt;
  }

  async settle(_ctx: SettleContext): Promise<void> {
    const rt = this.#rt;
    const tuner = rt.meta_tuner;
    const metrics = rt.turn_metrics;
    const knowledgeSet = rt.knowledge_set;
    if (tuner === null || metrics === null || knowledgeSet === null) return;
    try {
      const params = MetaTuner.load_params(knowledgeSet);
      tuner.tune_persisted(params, metrics);
    } catch {
      // 收尾调参失败只跳过（参数基线损坏/写入异常不阻断 run 交付）
    }
  }
}

/** 决议事件边界清理钩子的运行时访问面。 */
interface _ReviewBoundaryRuntime {
  _round_review_events: Record<
    string,
    Array<{ kind: string; detail: Record<string, unknown> }>
  >;
}

/** 回合边界清理：账本钩子并入决议事件后清空（防跨回合残留泄漏）。
 *  每次顶层 run 收尾清理（无 round_id 的 resume 收尾同样清理——决议事件
 *  已并入当轮账本/抽取，不残留到后续回合）。 */
class _ReviewEventBoundaryHook {
  readonly #rt: _ReviewBoundaryRuntime;

  constructor(rt: _ReviewBoundaryRuntime) {
    this.#rt = rt;
  }

  async settle(ctx: SettleContext): Promise<void> {
    delete this.#rt._round_review_events[ctx.thread_id || '-'];
  }
}

/** evolve_offline 调度选项（离线进化：失败率入队 → 变异 → 闸门防退化）。 */
export interface EvolveOfflineOptions {
  /** 单批候选上限（小批量防膨胀；缺省 3）。 */
  batch?: number;
  /** 额外失败日志覆盖（缺省取条目自身 failure_logs 留痕）。 */
  failure_logs?: Readonly<Record<string, readonly string[]>> | null;
  /** 知识闸门（EvolutionGate，真实 KnowledgeGate 结构满足）；null = 不评估。 */
  gate?: EvolutionGate | null;
  /** L1 schema 声明 / L2 完整样例库 / L3 回归用例（透传工厂）。 */
  schema?: unknown;
  fixtures?: unknown;
  regression?: unknown;
}

/** evolve_offline 结果（候选/尝试/保留/拒绝/重复留痕）。 */
export interface EvolveOfflineResult {
  candidates: number;
  evolved: number;
  kept: number;
  rejected: number;
  duplicated: number;
}

/** 缺省失败日志源（条目自身留痕——失败日志 = 反思式变异输入）。 */
function _entry_failure_logs(entries: readonly KnowledgeEntry[]): Record<string, readonly string[]> {
  const logs: Record<string, readonly string[]> = {};
  for (const entry of entries) {
    if (entry.failure_logs.length > 0) logs[entry.id] = entry.failure_logs;
  }
  return logs;
}

/** 自学习族装配层（回合记忆/技能结晶/进化调度/收尾调参）。 */
export abstract class RuntimeSelfLearning extends RuntimeRebuild {
  /** 自学习族装配（记忆存储/技能存储；engine 重建前调用，开关关闭 = 不装配）。 */
  _assemble_self_learning(guarded: Storage, recipe: AssemblyRecipe): void {
    if (recipe.memory_extract_enabled) {
      this.memory_store = new StorageBackedMemoryStore(
        guarded as never,
        _MEMORY_COLLECTION,
        {
          now: () => this._r_now(),
          id_gen: () => this._r_growth_uuid(),
        },
      );
    } else {
      this.memory_store = null;
    }
    if (recipe.skill_crystal_enabled) {
      this.knowledge_skill_store = new KnowledgeSkillStore(this.knowledge_set, {
        now: () => this._r_now(),
      });
    } else {
      this.knowledge_skill_store = null;
    }
    this._skill_crystallizer = null;
  }

  /** 沉淀链覆写：基础链（归因/账本）后接自学习族（顺序见文件头）。
   *  技能结晶自动触发源（指纹缓存命中）已随组装链路退役；技能容器
   *  （KnowledgeSkillStore）仍按 skill_crystal_enabled 装配供外部读写。 */
  override _assemble_settle_chain(): SettleHooks {
    const hooks = super._assemble_settle_chain();
    const recipe = this._recipe;
    if (recipe === null) return hooks;
    if (recipe.memory_extract_enabled && this.memory_store !== null) {
      hooks.register(
        new MemoryExtractSettleHook(this.memory_store, {
          namespace: DEFAULT_NAMESPACE,
          facts: (ctx) =>
            _round_ledger_facts(
              ctx,
              this._round_review_events[ctx.thread_id || '-'] ?? [],
            ),
        }),
      );
    }
    if (this.growth_pipeline !== null) hooks.register(this.growth_pipeline);
    if (this.entity_evolution_pipeline !== null) {
      hooks.register(this.entity_evolution_pipeline);
    }
    hooks.register(new _RoundTuneSettleHook(this as never));
    hooks.register(new _ReviewEventBoundaryHook(this as never));
    return hooks;
  }

  /**
   * 离线进化调度入口（产品内按需方法；宿主在收敛/批量流程中显式调用）。
   *
   * 语义对齐 evolution 工厂：失败率优先入队（次之长期未调用）→ 反思式变异
   * → 三层闸门防退化。闸门/样例缺省不注入 = 保守不评估（只返回候选统计，
   * 不产生任何回合内开销）；注入真实 KnowledgeGate + 领域 fixtures 后小批
   * 量择优，过闸变异体落知识集（补丁链 = 唯一演化史）。
   */
  async evolve_offline(options: EvolveOfflineOptions = {}): Promise<EvolveOfflineResult> {
    const knowledgeSet = this.knowledge_set;
    if (knowledgeSet === null) {
      return { candidates: 0, evolved: 0, kept: 0, rejected: 0, duplicated: 0 };
    }
    const entries = knowledgeSet.entries();
    const failureLogs =
      options.failure_logs ?? _entry_failure_logs(entries);
    const candidates = EvolutionFactory.collect_candidates(entries, { failure_logs: failureLogs });
    const ranked = EvolutionFactory.rank(candidates);
    const batch = Math.max(0, Math.trunc(options.batch ?? 3));
    const gate = options.gate ?? null;
    const result: EvolveOfflineResult = {
      candidates: ranked.length,
      evolved: 0,
      kept: 0,
      rejected: 0,
      duplicated: 0,
    };
    if (gate === null || batch === 0) return result;
    const factory = new EvolutionFactory(gate);
    for (const candidate of ranked.slice(0, batch)) {
      result.evolved += 1;
      let outcome;
      try {
        outcome = await factory.evolve(candidate, {
          schema: options.schema,
          fixtures: options.fixtures,
          regression: options.regression,
        });
      } catch {
        result.rejected += 1;
        continue;
      }
      result.rejected += outcome.rejected.length;
      for (const variant of outcome.variants) {
        if (knowledgeSet.get(variant.id) !== null) {
          result.duplicated += 1;
          continue;
        }
        try {
          knowledgeSet.add(variant);
          result.kept += 1;
        } catch {
          result.duplicated += 1;
        }
      }
    }
    return result;
  }
}
