// gate: 超限(365 行) - Runtime 引擎重建 + 引擎自承载装配面（round 数据图引擎同源共用装配，拆文件破坏装配清单一致维护）
/**
 * Runtime 引擎重建（rebuild_engine）与集状态恢复（_restore_set_state）。
 *
 * 重建缓存键 = 模型实例身份（is 比较）+ 存储身份 + 工具表结构身份——三者
 * 不变时复用既有引擎（「配置变更才重建」语义）。LLM 链守卫包装（用量闭环
 * + 回合内压缩）随引擎装配；沉淀钩子链（池治理登记/知识归因/自学习/实体
 * 演化）注册进 settle 与事件观察传输。
 *
 * 图配方非必需（graph_recipe=null = 引擎机制态无静态图）：rebuild_engine
 * 仅保留「配方给了静态图」时的兼容/内省通道（A5 再删），回合运行走 run 级
 * 组装——本层提供的 _build_graph_engine 把组装出的数据图 dict 装配成本轮
 * Engine（与静态图重建共用同一套 RunOptions/seams/沉淀/观察装配清单）。
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
import { Graph } from '../graph/graph.js';
import { bind_engine_node_seams } from '../nodes/index.js';
import { CompressingLLM, UsageTrackingLLM } from '../llm/guard.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import { HarnessDefinition } from '../harness/index.js';
import { KnowledgeSet } from '../knowledge_set/index.js';
import { emit_audit } from '../audit_log/audit_log.js';
import type { EngineTransport } from '../events/events.js';
import { UISchemaValidator } from '../ui_schema/uiSchema.js';
import type { AssemblyRecipe, GraphRecipeContext } from './_types.js';
import { _spec_identity } from './_helpers.js';
import { RuntimeMechanisms } from './_runtime_mechanisms.js';

/** 引擎重建/集状态恢复基座。 */
export abstract class RuntimeRebuild extends RuntimeMechanisms {
  /** 重建回合图引擎（配方静态图通道；graph_recipe=null = 无静态图）。
   *  llm 缺省 = 宿主解析。 */
  async rebuild_engine(llm?: AsyncLLM | null): Promise<Engine | null> {
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
    // 无静态图配方 = 引擎机制态无图（round 走 run 级组装）：不重建静态引擎
    if (this._recipe.graph_recipe === null) {
      this.engine = null;
      this.engine_llm = resolvedLlm;
      this._engine_storage = this.storage;
      this._engine_spec_key = specKey;
      return null;
    }
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
    const recipe = this._recipe;
    const guard_llm = this._guard_for(resolvedLlm);
    const context = this._graph_context(guard_llm, specs);
    // 引擎内置节点 seams 绑定：llm/流水线/工具表随本次重建刷新（工厂闭包
    // 持盒执行时现取——数据图装载在引擎构造时即可解析 llm_decider 等类型）
    this._bind_engine_seams(guard_llm, specs);
    const graph = recipe.graph_recipe!(context) as Graph;
    // 沉淀钩子链（引擎自接线，机制开关默认 ON，见 _runtime_mechanisms
    // _assemble_settle_chain：六钩子 + 池治理 + 归因/账本 + growth/实体演化）
    const settleHooks = this._assemble_settle_chain();
    // 回合事件观察传输：growth/实体演化 + 回合步骤记录器（同一流订阅）
    const transports = this._engine_transports();
    const options = new RunOptions({
      storage: this.storage,
      registries: context.registries,
      emit_timeline_events: this._recipe.emit_timeline_events,
      transports,
      system_events: context.system_events,
      assembly: context.assembly,
      assembly_sources: context.assembly_sources,
      settle: settleHooks,
      // 回合指标聚合注入：顶层 run/ainvoke 收尾引擎自动记录回合成败
      // （_record_run_metrics；此前不注入 = 判 null 跳过）——收尾调参
      // settle 钩子读同一实例聚合，不再由运行时侧重复记录
      metrics: this.turn_metrics,
    });
    this._apply_run_options_override(options, this._recipe.run_options as RunOptions | null);
    const engine = new Engine(graph, options);
    this._bind_pipeline_emitters(engine);
    this.engine = engine;
    this.engine_llm = resolvedLlm;
    this._engine_storage = this.storage;
    this._engine_spec_key = specKey;
    this.introspection_service?.set_graph(graph);
    return engine;
  }

  /** 组装出的本轮图定义 → 本轮执行 Engine（run 级组装入口/恢复重建共用；
   *  llm 缺省 = 宿主解析；域 = 边证据归因聚合键）。装配清单与 rebuild_engine
   *  静态图同源（options/seams/沉淀/观察传输逐项一致）。 */
  protected async _build_graph_engine(
    graphData: Record<string, unknown>,
    opts: { llm?: AsyncLLM | null; domain?: string | null } = {},
  ): Promise<Engine> {
    if (this._host === null || this._recipe === null) {
      throw new Error('运行时未装配（回合引擎构建须在 boot 之后）');
    }
    const registries = this.graph_registries;
    if (registries === null) {
      throw new Error('运行时注册表未装配（回合引擎构建失败）');
    }
    const resolvedLlm =
      opts.llm !== undefined && opts.llm !== null
        ? opts.llm
        : (await this._host.resolve_llm());
    const specs = this.collect_specs();
    const guard_llm = this._guard_for(resolvedLlm);
    this._bind_engine_seams(guard_llm, specs);
    const graph = Graph.from_dict(graphData, {
      registry: registries.nodes,
      edge_registry: registries.edges,
    });
    const settleHooks = this._assemble_settle_chain();
    // 引擎自接线观察传输 + 宿主/壳挂载的回合观察链（serve/run 订阅见
    // round_transports）——每轮引擎重建都带上，回合事件两路同送
    const transports = [...this._engine_transports(), ...this.round_transports];
    const options = new RunOptions({
      storage: this.storage,
      registries,
      // 组装时间线由回合入口发射（assemble_round/resume 收口处按事件类型
      // 直出），数据图引擎不再重复发射 turn_started/assembly_* 标记——
      // 装配域 run_options 覆写后强制关（本字段只属回合入口发射通道）
      emit_timeline_events: false,
      transports,
      system_events: this.event_type_registry?.system_events() ?? new Set<string>(),
      assembly: new AssemblyConfig(),
      assembly_sources: this._assembly_sources(),
      settle: settleHooks,
      metrics: this.turn_metrics,
      ...(opts.domain !== null && opts.domain !== undefined ? { domain: opts.domain } : {}),
    });
    this._apply_run_options_override(options, this._recipe.run_options as RunOptions | null);
    // 组装时间线事件专属回合入口通道：run_options 覆写（如产品 emit_timeline_events
    // 默认开）不改数据图引擎——入口按需自行发射，引擎零重复
    options.emit_timeline_events = false;
    const engine = new Engine(graph, options);
    this._bind_pipeline_emitters(engine);
    // 内省图数据源随本轮组装图刷新：宿主 graph.instance/架构读口取「最近回合
    // 组装图投影」；无任何回合（或仅静态引擎装配）= 保持空态 degraded 不报错
    this.introspection_service?.set_graph(engine.graph);
    return engine;
  }

  /** LLM 守卫链包装：usage 帧进结点成本账，调用前按压缩策略折叠历史。 */
  private _guard_for(resolvedLlm: AsyncLLM | null): AsyncLLM | null {
    if (resolvedLlm === null) return null;
    const recipe = this._recipe!;
    const compress_policy = recipe.compress_policy;
    return new UsageTrackingLLM(
      new CompressingLLM(resolvedLlm, {
        policy: compress_policy ?? new ThresholdCompressionPolicy(),
      }),
    );
  }

  /** 引擎内置节点 seams 绑定（引擎重建/回合引擎构建处调用）。 */
  private _bind_engine_seams(guard_llm: AsyncLLM | null, specs: readonly import('../llm/tools.js').ToolSpec[]): void {
    if (this.graph_registries === null) return;
    bind_engine_node_seams(this.graph_registries, {
      llm: guard_llm,
      tool_pipeline: this.tool_pipeline,
      tool_specs: specs,
      all_tool_specs: this.merged_specs(),
      collect_specs: (thread_id?: string | null) => this.collect_specs(thread_id),
    });
  }

  /** 回合事件观察传输清单（growth/实体演化 + 回合步骤记录器）。 */
  private _engine_transports(): EngineTransport[] {
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
    return transports;
  }

  /** 自学习/实体演化发射回调接入引擎事件流（观测不阻断沉淀链路）。 */
  private _bind_pipeline_emitters(engine: Engine): void {
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
  ): GraphRecipeContext {
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
  protected _apply_run_options_override(
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

  /** 从集补丁链组装恢复活跃态（重启/回退后集状态一致；链损坏回落基线）。
   *  各段恢复失败只跳过不击穿启动；失败原因逐段汇总到 _restore_diag
   *  （可观测：回落基线是显式降级而非静默吞错）。 */
  async _restore_set_state(recipe: AssemblyRecipe): Promise<void> {
    const diag: string[] = [...this._restore_diag];
    const chain = this.self_pipeline?.chain ?? null;
    if (chain === null) {
      this._restore_diag = [...diag, '集补丁链未装配（自指管线缺链），集状态恢复跳过'];
      return;
    }
    let state: Record<string, unknown>;
    try {
      state = (await chain.assemble()) as Record<string, unknown>;
    } catch (exc) {
      this._restore_diag = [...diag, `集状态组装失败（回落基线）: ${String(exc)}`];
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
          } else {
            diag.push(`界面恢复未通过白名单校验（${violations.length} 项违规，回落基线）`);
          }
        } catch (exc) {
          diag.push(`界面恢复校验失败（跳过）: ${String(exc)}`);
        }
      }
    }
    const harnessState = state['harness'];
    if (harnessState && typeof harnessState === 'object') {
      const registry = this.harness_registry;
      if (registry === null) {
        diag.push('harness 段存在但注册表未装配（跳过恢复）');
      } else {
        for (const [name, data] of Object.entries(
          harnessState as Record<string, unknown>,
        )) {
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
          try {
            const parsed = HarnessDefinition.from_dict(data as never);
            registry.register(parsed);
          } catch (exc) {
            diag.push(`harness 恢复失败（跳过）: ${name} ${String(exc)}`);
          }
        }
      }
    }
    const toolsState = state['tools'];
    if (toolsState && typeof toolsState === 'object') {
      const registry = this.harness_registry;
      if (registry === null) {
        diag.push('工具段存在但 harness 注册表未装配（跳过恢复）');
      } else {
        for (const [name, toolData] of Object.entries(
          toolsState as Record<string, unknown>,
        )) {
          if (!toolData || typeof toolData !== 'object' || Array.isArray(toolData)) continue;
          try {
            const declarative = DeclarativeToolSpec.from_dict(toolData as never);
            registry.declarative.register_definition(declarative);
            this.tool_registry[name] = declarative.to_spec();
          } catch (exc) {
            diag.push(`工具恢复失败（跳过）: ${name} ${String(exc)}`);
          }
        }
      }
    }
    const eventState = state['event_types'];
    if (eventState && typeof eventState === 'object') {
      const registry = this.event_type_registry;
      if (registry === null) {
        diag.push('事件类型段存在但注册表未装配（跳过恢复）');
      } else {
        const existing = new Set(registry.names());
        for (const [name, specData] of Object.entries(
          eventState as Record<string, unknown>,
        )) {
          if (!specData || typeof specData !== 'object' || Array.isArray(specData)) continue;
          if (existing.has(name)) continue;
          try {
            registry.register(EventTypeSpec.from_dict(specData as never));
          } catch (exc) {
            diag.push(`事件类型恢复失败（跳过）: ${name} ${String(exc)}`);
          }
        }
      }
    }
    const entityState = state['entities'];
    if (entityState && typeof entityState === 'object') {
      const registry = this.entity_registry;
      if (registry === null) {
        diag.push('实体段存在但实体注册表未装配（跳过恢复）');
      } else {
        const existing = new Set(registry.names());
        for (const [entity_id, specData] of Object.entries(
          entityState as Record<string, unknown>,
        )) {
          if (!specData || typeof specData !== 'object' || Array.isArray(specData)) continue;
          let spec: EntitySpec | null = null;
          try {
            spec = EntitySpec.from_dict(specData as never);
          } catch (exc) {
            diag.push(`实体反序列化失败（跳过）: ${entity_id} ${String(exc)}`);
            continue;
          }
          try {
            if (existing.has(entity_id)) registry.replace(spec);
            else registry.register(spec);
          } catch (exc) {
            diag.push(`实体恢复失败（跳过）: ${entity_id} ${String(exc)}`);
          }
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
      } catch (exc) {
        diag.push(`知识集恢复失败（跳过）: ${String(exc)}`);
      }
    }
    this._restore_diag = diag;
  }
}
