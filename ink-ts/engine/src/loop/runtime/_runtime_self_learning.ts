/**
 * 自学习族装配层（D04/D05 接线）：回合记忆抽取、技能容器、回合收尾调参。
 *
 * - 记忆：回合收尾把当轮账本事实（意图/结论 + 用户决议确认事件）规则抽取
 *   入用户级 memory 域（StorageBackedMemoryStore = EvolutionWriter
 *   kind=memory 受控通道），settle 钩子按 thread+round 幂等（同 round
 *   不重复抽取）；
 * - 技能容器：KnowledgeSkillStore = 知识集 kind=path 条目访问器（知识集
 *   补丁链 = 唯一演化史）；结晶自动触发源（指纹缓存命中）已随组装链路
 *   退役，容器与互转保持，观察侧 skill_crystallizer 恒空；
 * - 收尾调参：普通回合收尾经 settle 钩子接入 MetaTuner，回合指标由引擎
 *   注入 RunOptions.metrics 聚合一次。
 *
 * 沉淀链顺序（super 基础链 …归因/账本之后）：记忆抽取 → 收尾调参 →
 * 决议事件边界清理。（growth/entity_evolution/evolve_offline 等 legacy
 * 演化管线装配已随 S6 删除——受控进化活线覆盖其职能，§7.2。）
 */

import type { KnowledgeEntry } from '../../core/knowledge_set/index.js';
import type { KnowledgeSet } from '../../core/knowledge_set/index.js';
import { StorageBackedMemoryStore } from '../../evolve/learn/memory/index.js';
import {
  DEFAULT_NAMESPACE,
  MemoryExtractSettleHook,
} from '../../evolve/learn/memory_extract/index.js';
import type { SettleContext, SettleHooks } from '../turn_settle/index.js';
import { KnowledgeSkillStore } from '../../evolve/skill/crystallization/index.js';
import type { Storage } from '../../dock/ports/storage.js';
import { MetaTuner } from '../../evolve/param_tuning/index.js';
import type { TunableParams, TurnMetrics } from '../../evolve/param_tuning/index.js';
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

/** 自学习族装配层（回合记忆/技能结晶/收尾调参）。 */
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
    hooks.register(new _RoundTuneSettleHook(this as never));
    hooks.register(new _ReviewEventBoundaryHook(this as never));
    return hooks;
  }
}
