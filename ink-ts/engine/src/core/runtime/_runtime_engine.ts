/**
 * Runtime 引擎重建（rebuild_engine）与集状态恢复（_restore_set_state）。
 *
 * 重建缓存键 = 模型实例身份（is 比较）+ 存储身份 + 工具表结构身份——三者
 * 不变时复用既有引擎（「配置变更才重建」语义）。LLM 链守卫包装（用量闭环
 * + 回合内压缩）随引擎装配；沉淀钩子链（池治理登记/知识归因/自学习/实体
 * 演化）注册进 settle 与事件观察传输。
 *
 * _restore_set_state：链是权威记录——界面描述/harness/动态工具/事件类型/
 * 知识按最新组装形态重建运行时视图；恢复失败只跳过不击穿启动（回落基线）。
 */

import { AssemblyConfig } from '../assembly/index.js';
import { ThresholdCompressionPolicy } from '../context/context_compression.js';
import { DeclarativeToolSpec } from '../declarative_tools/index.js';
import { EventTypeSpec } from '../event_types/eventTypeSpec.js';
import { EntitySpec } from '../entities/entities.js';
import { Engine, RunOptions } from '../executor/index.js';
import { CompressingLLM, UsageTrackingLLM } from '../llm/guard.js';
import { Message } from '../llm/messages.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import { HarnessDefinition } from '../harness/index.js';
import { KnowledgeSet } from '../knowledge_set/index.js';
import { SettleHooks, PoolGovernanceSettleHook } from '../settle/index.js';
import { emit_audit } from '../audit_log/audit_log.js';
import type { EngineTransport } from '../events/events.js';
import { UISchemaValidator } from '../ui_schema/uiSchema.js';
import { LLMOutputVerifier } from '../verifier/verifier.js';
import type { Graph } from '../graph/graph.js';
import type { AssemblyRecipe } from './_types.js';
import { _spec_identity } from './_helpers.js';
import { _KnowledgeUsageSettleHook, _LedgerSettleHook } from './_settle.js';
import { _RoundStepsRecorder } from './_round_steps_recorder.js';
import { RuntimeContexts } from './_runtime_contexts.js';

/** 引擎重建/集状态恢复基座。 */
export abstract class RuntimeRebuild extends RuntimeContexts {
  /** 重建回合图引擎（配置/工具表变更才重建；llm 缺省 = 宿主解析）。 */
  async rebuild_engine(llm?: AsyncLLM | null): Promise<Engine> {
    if (this._host === null || this._recipe === null) {
      throw new Error('运行时未装配（rebuild_engine 须在 boot 之后）');
    }
    const resolvedLlm = llm ?? (await this._host.resolve_llm());
    const specs = this.collect_specs();
    // 缓存键须含工具**身份**（名称+结构序列化），而非仅名称：同名工具被
    // 补丁改写端点/参数时旧缓存仍命中 → 引擎持有过期 schema
    const specKey = specs
      .map((s) => `${s.name}\u241f${_spec_identity(s)}`)
      .sort();
    if (
      this.engine !== null
      && this.engine_llm === resolvedLlm
      && this.storage === this._engine_storage
      && specKey.join('\n') === (this._engine_spec_key ?? []).join('\n')
    ) {
      return this.engine;
    }
    // 引擎重建前显式关闭旧 LLM 链（模型变更时旧链连接池悬置；失败只跳过）
    if (this.engine_llm !== null && this.engine_llm !== resolvedLlm) {
      try {
        await this.engine_llm.aclose();
      } catch {
        // 旧 LLM 链关闭失败（继续重建）
      }
    }
    // LLM 链守卫包装：usage 帧进结点成本账，调用前按压缩策略折叠历史
    let guard_llm: AsyncLLM | null = null;
    if (resolvedLlm !== null) {
      const compress_policy = this._recipe.compress_policy;
      guard_llm = new UsageTrackingLLM(
        new CompressingLLM(resolvedLlm, {
          policy: compress_policy ?? new ThresholdCompressionPolicy(),
        }),
      );
    }
    const recipe = this._recipe;
    const context = this._graph_context(guard_llm, specs);
    const graph = recipe.graph_recipe!(context) as Graph;
    // 沉淀钩子链（引擎自接线，默认 ON）：
    // ① 池治理每回合自动跑（评估边证据 → 判定 → 审计/失效登记）；
    // ② 知识使用归因（失败知识 → 进化候选）；
    // ③ 回合账本归约（当轮可归约记录 → ledger 集合）；
    // ④ 自学习闭环（growth，回合收尾按需蒸馏）；
    // ⑤ 实体演化闭环（失败信号 → 变异 → 晋升）。
    const settleHooks = new SettleHooks();
    if (this.pool_governance !== null && this._pool_governance_enabled) {
      settleHooks.register(
        new PoolGovernanceSettleHook(this.pool_governance, {
          store: this.edge_evidence_store,
          now: () => this._r_now(),
          audit_sink: (record) => this._pool_governance_audit(record),
        }),
      );
    }
    settleHooks.register(new _KnowledgeUsageSettleHook(this));
    settleHooks.register(new _LedgerSettleHook(this));
    if (this.growth_pipeline !== null) {
      settleHooks.register(this.growth_pipeline);
    }
    if (this.entity_evolution_pipeline !== null) {
      settleHooks.register(this.entity_evolution_pipeline);
    }
    // 回合事件观察传输：growth/实体演化 + 回合步骤记录器（同一流订阅）
    const transports: EngineTransport[] = [];
    if (this.entity_evolution_pipeline !== null) {
      transports.push(this.entity_evolution_pipeline);
    }
    if (this.growth_pipeline !== null) {
      transports.push(this.growth_pipeline);
    }
    if (this.round_steps_recorder !== null) {
      transports.push(this.round_steps_recorder);
    }
    // VTM 验证器门控：guard_llm 结构上不满足 verifier 的窄 ainvoke 契约
    // （verifier 消息 = 扁平 {role, content}），显式适配为 Message 形态再
    // 调用（行为与 Python 把 guard LLM 交给 verifier 一致，无宽形态透传）
    const needsVerifier = recipe.verify_retry_limit > 0 && guard_llm !== null;
    const options = new RunOptions({
      storage: this.storage,
      registries: context.registries,
      output_verifier: needsVerifier
        ? new LLMOutputVerifier({
            ainvoke: async (messages) => {
              const result = await guard_llm!.ainvoke(
                messages.map((m) => new Message(m.role, m.content)),
              );
              return { content: result.content };
            },
          })
        : null,
      verify_retry_limit: recipe.verify_retry_limit,
      emit_timeline_events: recipe.emit_timeline_events,
      transports,
      system_events: context.system_events,
      assembly: context.assembly,
      assembly_sources: context.assembly_sources,
      settle: settleHooks,
    });
    this._apply_run_options_override(options, recipe.run_options as RunOptions | null);
    const engine = new Engine(graph, options);
    // 自学习/实体演化发射回调接入引擎事件流（观测不阻断沉淀链路）
    if (this.growth_pipeline !== null) {
      this.growth_pipeline.set_emit((etype, payload) =>
        engine.publish_event(etype, payload as Record<string, unknown>, {
          thread_id: '-',
          node: 'growth',
        }));
    }
    if (this.entity_evolution_pipeline !== null) {
      this.entity_evolution_pipeline.set_emit((etype, payload) =>
        engine.publish_event(etype, payload, {
          thread_id: '-',
          node: 'entity_evolution',
        }));
    }
    this.engine = engine;
    this.engine_llm = resolvedLlm;
    this._engine_storage = this.storage;
    this._engine_spec_key = specKey;
    this.introspection_service?.set_graph(graph);
    return engine;
  }

  /** 池治理判定留痕 → set_audit（append-only；审计不阻断治理主流程）。 */
  _pool_governance_audit(record: Record<string, unknown>): unknown {
    try {
      return emit_audit(
        this.storage,
        { ...record },
        { now: () => this._r_now(), keyGen: () => this._r_audit_key() },
      );
    } catch {
      return null;
    }
  }

  /** 图配方装配期上下文（GraphRecipeContext）。 */
  private _graph_context(
    guard_llm: AsyncLLM | null,
    specs: readonly import('../llm/tools.js').ToolSpec[],
  ): import('./_types.js').GraphRecipeContext {
    return {
      llm: guard_llm,
      tool_pipeline: this.tool_pipeline,
      tool_specs: specs,
      all_tool_specs: this.merged_specs(),
      collect_specs: (thread_id?: string | null) => this.collect_specs(thread_id),
      storage: this.storage,
      registries: this.graph_registries,
      system_events: this.event_type_registry?.system_events() ?? new Set<string>(),
      assembly: new AssemblyConfig(),
      assembly_sources: this._assembly_sources(),
    };
  }

  /** 配方执行域覆盖：非 None 字段覆盖装配默认（声明即权威）。 */
  private _apply_run_options_override(
    options: RunOptions,
    runOptions: RunOptions | null,
  ): void {
    if (runOptions === null) return;
    for (const key of Object.keys(runOptions)) {
      const value = (runOptions as unknown as Record<string, unknown>)[key];
      if (value !== null && value !== undefined) {
        (options as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }

  /** 从集补丁链组装恢复活跃态（重启/回退后集状态一致；链损坏回落基线）。 */
  async _restore_set_state(recipe: AssemblyRecipe): Promise<void> {
    let state: Record<string, unknown>;
    try {
      state = (await this.self_pipeline!.chain.assemble()) as Record<string, unknown>;
    } catch {
      // 集状态组装失败，回落基线
      return;
    }
    const uiState = state['ui'];
    if (uiState && typeof uiState === 'object' && !Array.isArray(uiState)) {
      const ui = uiState as Record<string, unknown>;
      const spec = ui['boot.panel'] ?? ui[Object.keys(ui)[0] ?? ''];
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
        try {
          const violations = new UISchemaValidator().validate(spec, {
            allowed_components: recipe.ui_allowed_components,
            allowed_channels: recipe.ui_allowed_channels,
            allowed_theme_tokens: recipe.ui_allowed_theme_tokens,
          });
          if (violations.length === 0) {
            (this.introspection_service as unknown as { _sources: { ui_spec: Record<string, unknown> | null } })._sources.ui_spec = spec as Record<string, unknown>;
          }
        } catch {
          // 界面恢复校验失败（跳过）
        }
      }
    }
    const harnessState = state['harness'];
    if (harnessState && typeof harnessState === 'object') {
      for (const [name, data] of Object.entries(
        harnessState as Record<string, unknown>,
      )) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        try {
          const parsed = HarnessDefinition.from_dict(data as never);
          this.harness_registry!.register(parsed);
        } catch {
          // harness 恢复失败（跳过）
          void name;
        }
      }
    }
    const toolsState = state['tools'];
    if (toolsState && typeof toolsState === 'object') {
      for (const [name, toolData] of Object.entries(
        toolsState as Record<string, unknown>,
      )) {
        if (!toolData || typeof toolData !== 'object' || Array.isArray(toolData)) continue;
        try {
          const declarative = DeclarativeToolSpec.from_dict(toolData as never);
          this.harness_registry!.declarative.register_definition(declarative);
          this.tool_registry[name] = declarative.to_spec();
        } catch {
          // 工具恢复失败（跳过）
        }
      }
    }
    const eventState = state['event_types'];
    if (eventState && typeof eventState === 'object') {
      const existing = new Set(this.event_type_registry!.names());
      for (const [name, specData] of Object.entries(
        eventState as Record<string, unknown>,
      )) {
        if (!specData || typeof specData !== 'object' || Array.isArray(specData)) continue;
        if (existing.has(name)) continue;
        try {
          this.event_type_registry!.register(EventTypeSpec.from_dict(specData as never));
        } catch {
          // 事件类型恢复失败（跳过）
        }
      }
    }
    const entityState = state['entities'];
    if (entityState && typeof entityState === 'object') {
      const registry = this.entity_registry!;
      const existing = new Set(registry.names());
      for (const [entity_id, specData] of Object.entries(
        entityState as Record<string, unknown>,
      )) {
        if (!specData || typeof specData !== 'object' || Array.isArray(specData)) continue;
        let spec: EntitySpec | null = null;
        try {
          spec = EntitySpec.from_dict(specData as never);
        } catch {
          // 实体恢复失败（跳过）
          continue;
        }
        try {
          if (existing.has(entity_id)) registry.replace(spec);
          else registry.register(spec);
        } catch {
          // 实体恢复失败（跳过）
        }
      }
    }
    const knowledgeState = state['knowledge'];
    if (
      knowledgeState
      && typeof knowledgeState === 'object'
      && !Array.isArray(knowledgeState)
      && Object.keys(knowledgeState).length > 0
    ) {
      try {
        // 知识集内存链按集状态重建（权威 = 集补丁链）
        const rebuilt = KnowledgeSet.from_export(
          recipe.set_id,
          { base: { entries: knowledgeState }, patches: [] },
          { storage: this.storage as never },
        );
        // 变更钩子重挂：from_export 新建实例不带 on_mutation
        if (this._knowledge_mutation_hook !== null) {
          (rebuilt as unknown as { on_mutation: (() => void) | null }).on_mutation =
            this._knowledge_mutation_hook;
        }
        this.knowledge_set = rebuilt;
        // 内省视图同步指向恢复后的集实例
        if (this.introspection_service !== null) {
          (this.introspection_service as unknown as { _sources: { knowledge_set: KnowledgeSet } })._sources.knowledge_set = rebuilt;
        }
      } catch {
        // 知识集恢复失败（跳过）
      }
    }
  }
}
