// gate: 超限(390 行) - Runtime 引擎重建 + 引擎自承载装配面（round 数据图引擎同源共用装配，拆文件破坏装配清单一致维护）
/**
 * Runtime LLM 链刷新 + 按图引擎构建 + 集状态恢复。
 *
 * 引擎 = 无常驻静态 Engine（无静态引擎态 = 常态）：rebuild_engine 不再产出
 * 常驻静态引擎，只负责刷新已解析宿主 LLM 链——宿主关停旧链/重解析后经
 * rebuild_engine 记录新链并显式关闭换下的旧链（模型变更旧连接池不悬置），
 * stop 时统一关停。每轮回合的执行引擎由 _build_graph_engine(graphData) 按
 * 本轮组装数据图装配（组装/恢复/分支共用同一装配函数，装配清单 =
 * RunOptions/seams/沉淀/观察传输逐项一致）。
 *
 * 内省图数据源随每轮构建刷新为「最近回合组装图」；无任何回合 = 保持空态
 * degraded 不报错。LLM 守卫链包装（用量闭环 + 回合内压缩）随回合引擎装配；
 * 沉淀钩子链（池治理登记/知识归因/自学习/实体演化）注册进 settle 与事件
 * 观察传输。
 *
 * _restore_set_state：链是权威记录——界面描述/harness/动态工具/事件类型/
 * 知识按最新组装形态重建运行时视图；恢复失败只跳过不击穿启动（回落基线）。
 */

import { AssemblyConfig } from '../../core/assembly/index.js';
import { ThresholdCompressionPolicy } from '../../core/context/context_compression.js';
import { DeclarativeToolSpec } from '../../core/declarative_tools/index.js';
import { EventTypeSpec } from '../../core/event_types/eventTypeSpec.js';
import { EntitySpec } from '../../core/entities/entities.js';
import { Engine, RunOptions } from '../executor/index.js';
import { Graph } from '../../core/graph/graph.js';
import { bind_engine_node_seams } from '../../core/nodes/index.js';
import { CompressingLLM, UsageTrackingLLM } from '../llm/guard.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import { HarnessDefinition } from '../../core/harness/index.js';
import { KnowledgeSet } from '../../core/knowledge_set/index.js';
import { emit_audit } from '../audit_log/audit_log.js';
import type { EngineTransport } from '../../core/events/events.js';
import { UISchemaValidator } from '../../core/ui_schema/uiSchema.js';
import type { AssemblyRecipe } from './_types.js';
import { RuntimeMechanisms } from './_runtime_mechanisms.js';

/** 引擎重建/集状态恢复基座。 */
export abstract class RuntimeRebuild extends RuntimeMechanisms {
  /** 刷新已解析宿主 LLM 链（无常驻静态引擎；llm 缺省 = 宿主解析）。
   *  换入新链时显式关闭旧链（模型变更后旧连接池不悬置；失败只跳过）。 */
  async rebuild_engine(llm?: AsyncLLM | null): Promise<void> {
    if (this._host === null || this._recipe === null) {
      throw new Error('运行时未装配（rebuild_engine 须在 boot 之后）');
    }
    const resolvedLlm = llm ?? (await this._host.resolve_llm());
    if (this.engine_llm !== null && this.engine_llm !== resolvedLlm) {
      try {
        await this.engine_llm.aclose();
      } catch {
        // 旧 LLM 链关闭失败（继续记录新链）
      }
    }
    this.engine_llm = resolvedLlm;
  }

  /** 组装出的本轮图定义 → 本轮执行 Engine（run 级组装入口/恢复重建共用；
   *   llm 缺省 = 宿主解析；域 = 边证据归因聚合键）。装配清单 = 回合组装/恢复
   *   同源（options/seams/沉淀/观察传输逐项一致），每轮回合引擎独立装配。 */
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
    // 多径组装上下文 seam：从已挂载的组装运行期窄化注入（executor 不反向
    // 读组装模块级默认，见 _engine_multipath）。未挂载 = 零证据/零回馈。
    const assembly = this.assembly_runtime;
    if (assembly !== null) {
      options.multipath_assembly = {
        evidence_store: assembly.evidence_store,
        sink: assembly.sink,
        report_cache_execution: (request: unknown, report_opts) =>
          assembly.report_cache_execution(request as never, report_opts),
      };
    }
    this._apply_run_options_override(options, this._recipe.run_options as RunOptions | null);
    // 组装时间线事件专属回合入口通道：run_options 覆写（如产品 emit_timeline_events
    // 默认开）不改数据图引擎——入口按需自行发射，引擎零重复
    options.emit_timeline_events = false;
    const engine = new Engine(graph, options);
    this._bind_pipeline_emitters(engine);
    // 内省图数据源随本轮组装图刷新：宿主 graph.instance/架构读口取「最近回合
    // 组装图投影」；无任何回合 = 保持空态 degraded 不报错
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

  /** 引擎内置节点 seams 绑定（回合引擎构建处调用）。 */
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
