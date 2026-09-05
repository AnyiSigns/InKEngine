/**
 * Runtime 装配（runtime.py ``_assemble`` 移植）：装配步骤 ①–⑰——存储/注册表/
 * 种子/成长管线/harness/事件类型/实体/校验器/自指管线/界面/元工具/检索源/
 * 统一流水线/集状态恢复/常驻集/工具索引/apply 目标/调参/池治理/引擎重建。
 * MCP 管理器与默认 embedder 为宿主装配面（未迁 core）：mcp seam 未注入即
 * 不启用；ToolVectorIndex 以关键词基线构建。
 */
import { PermissionGate } from '../permissions/permissions.js';
import { register_perception_nodes } from '../perception/perception.js';
import { EventTypeRegistry } from '../event_types/registry.js';
import {
  event_types_collection,
  EventTypeSpec,
} from '../event_types/eventTypeSpec.js';
import {
  EntityRegistry,
  entity_collection,
} from '../entities/entities.js';
import { DefaultEvolutionWriter } from '../evolution_writer/evolution_writer.js';
import {
  harness_collection,
  HarnessRegistry,
  HarnessRepository,
} from '../harness/index.js';
import {
  build_introspection_pipeline,
  IntrospectionService,
  IntrospectionSources,
  introspection_tool_specs,
  make_introspection_executor,
} from '../introspection/index.js';
import { GrowthPipeline } from '../growth/index.js';
import { KnowledgeSet, seed_knowledge_set } from '../knowledge_set/index.js';
import { seed_general } from '../seeds/seeds.js';
import {
  declarative_failure_reason,
  declarative_operation,
} from '../declarative_tools/index.js';
import { EntityEvolutionPipeline } from '../entity_evolution/index.js';
import { GuardedStorage, SelfApplicationPipeline } from '../self_application/index.js';
import { GraphRegistries } from '../registry/registry.js';
import { ProposalValidator } from '../self_proposal/index.js';
import { MetaTuner, TurnMetrics } from '../tuning/index.js';
import { KnowledgeSetRetriever, RetrieverRegistry } from '../retrieval/index.js';
import { ToolPipeline } from '../tool_pipeline/tool_pipeline.js';
import { ToolSelector } from '../tool_orchestrator/tool_orchestrator.js';
import { ToolVectorIndex } from '../tool_index/tool_index.js';
import { ToolVetting } from '../tool_vetting/tool_vetting.js';
import { PoolGovernance } from '../pool_governance/pool_governance.js';
import { EdgeEvidenceStore } from '../edge_evidence/store.js';
import { UISchemaValidator } from '../ui_schema/uiSchema.js';
import type { ToolSpec } from '../llm/tools.js';
import type { Host, AssemblyRecipe } from './_types.js';
import { _uuid_hex } from './_runtime_base.js';
import { _RoundStepsRecorder } from './_round_steps_recorder.js';
import { RuntimeRebuild } from './_runtime_engine.js';
/** 装配基座（步骤 ①–⑰ 实现；boot 失败清理见状态机层）。 */
export abstract class RuntimeAssemble extends RuntimeRebuild {
  protected async _assemble(host: Host, recipe: AssemblyRecipe): Promise<void> {
    const rawStorage = await host.create_storage();
    const guardToken = _uuid_hex();
    const guarded = new GuardedStorage(rawStorage, { guard_token: guardToken });
    this.storage = guarded;
    this.guard_token = guardToken;
    this.graph_registries = new GraphRegistries();
    try {
      register_perception_nodes(this.graph_registries.nodes);
    } catch {
    }
    this._persist_tasks = new Set();
    const persistKnowledgeSet = async (): Promise<void> => {
      if (this.knowledge_set === null || this.storage === null) return;
      try {
        const scope = this.storage.allow_mechanism(this.knowledge_set.collection);
        scope.enter();
        try {
          await this.knowledge_set.save();
        } finally {
          scope.exit();
        }
      } catch {
        // 知识集落库失败（本次知识演化未持久化）
      }
    };
    const onKnowledgeMutated = (): void => {
      const task = persistKnowledgeSet();
      this._persist_tasks.add(task);
      void task.then(
        () => this._persist_tasks.delete(task),
        () => this._persist_tasks.delete(task),
      );
    };
    this._knowledge_mutation_hook = onKnowledgeMutated;
    this.knowledge_set = await KnowledgeSet.load(recipe.set_id, {
      storage: guarded as never,
    });
    (this.knowledge_set as unknown as { on_mutation: (() => void) | null }).on_mutation =
      onKnowledgeMutated;
    const seedScope = guarded.allow_mechanism();
    seedScope.enter();
    try {
      seed_general(this.knowledge_set);
      for (const [, provider] of recipe.seeds) {
        seed_knowledge_set(this.knowledge_set, provider());
      }
    } finally {
      seedScope.exit();
    }
    // 回合记录/边证据装配产物（引擎自接线状态跨引擎重建持有）
    this.round_steps_recorder = new _RoundStepsRecorder();
    this.edge_evidence_store = new EdgeEvidenceStore();
    this.growth_pipeline = new GrowthPipeline(this.knowledge_set, {
      metric_store: guarded as never,
      now: () => this._r_now(),
      uuid_gen: () => this._r_growth_uuid(),
    });
    this.harness_registry = new HarnessRegistry({ registries: this.graph_registries });
    this.harness_repository = new HarnessRepository(guarded, null, {
      set_id: recipe.set_id,
    });
    for (const definition of recipe.harness_definitions) {
      this.harness_registry.register(definition);
      let existing: unknown = null;
      try {
        existing = await this.harness_repository.get(definition.name);
      } catch {
        existing = null;
      }
      const same =
        existing !== null
        && (existing as { to_dict: () => unknown }).to_dict()
          === (definition as unknown as { to_dict: () => unknown }).to_dict();
      if (same) continue;
      const scope = guarded.allow_mechanism(harness_collection(recipe.set_id));
      scope.enter();
      try {
        await this.harness_repository.save(definition, {
          note: '开局装配：自举领域基线',
        });
      } finally {
        scope.exit();
      }
    }
    this._mechanism_writer = new DefaultEvolutionWriter(guarded, {
      now: () => this._r_now(),
      keyGen: () => this._r_audit_key(),
    });
    const writer = this._mechanism_writer;
    this.event_type_registry = new EventTypeRegistry({
      recordsStore: guarded as never,
      writer: {
        write: (collection: string, name: string, data: Record<string, unknown>) =>
          writer.write(collection, name, data as never, {
            kind: 'event_type',
            asset_id: name,
            note: 'runtime_assembled',
          }),
      },
      set_id: recipe.set_id,
    });
    for (const spec of recipe.event_type_specs) {
      this.event_type_registry.register(spec);
    }
    const etScope = guarded.allow_mechanism(event_types_collection(recipe.set_id));
    etScope.enter();
    try {
      await this.event_type_registry.load();
      await this.event_type_registry.save();
    } finally {
      etScope.exit();
    }
    this.entity_registry = new EntityRegistry({
      recordsStore: guarded as never,
      writer,
      set_id: recipe.set_id,
    });
    const entityCollection = entity_collection(recipe.set_id);
    const entScope = guarded.allow_mechanism(entityCollection);
    entScope.enter();
    try {
      await this.entity_registry.load();
    } finally {
      entScope.exit();
    }
    for (const spec of recipe.entity_specs) {
      if (this.entity_registry.get(spec.id) === null) {
        this.entity_registry.register(spec);
      }
    }
    const entScope2 = guarded.allow_mechanism(entityCollection);
    entScope2.enter();
    try {
      await this.entity_registry.save();
    } finally {
      entScope2.exit();
    }
    this.entity_evolution_pipeline = new EntityEvolutionPipeline(
      this.entity_registry,
      writer,
    );
    this._ui_factory_components = new Set(recipe.ui_allowed_components);
    this._ui_components_disabled = await this._load_ui_components_disabled();
    const uiAllowedComponents = [...this.ui_allowed_components];
    this.validator = new ProposalValidator({
      allowed_components: uiAllowedComponents,
      allowed_channels: recipe.ui_allowed_channels,
      allowed_theme_tokens: recipe.ui_allowed_theme_tokens,
      graph_registries: this.graph_registries,
    });
    this.vetting = new ToolVetting({
      static_hooks: (recipe.vetting_static_hooks ?? []) as never,
    });
    this._host_policy = host.interrupt_policy();
    this.self_pipeline = new SelfApplicationPipeline({
      storage: guarded,
      validator: this.validator,
      approval_levels: recipe.approval_levels as never,
      interrupt_policy: this._host_policy as never,
      l2_vetting: recipe.vetting_l2_hook as never,
      on_reverted: recipe.on_reverted as never,
      guard_token: guardToken,
      // 审计键/时钟注入：runtime 实例唯一键源 + 运行时时钟（见第 2 节）
      now: () => this._r_now(),
      audit_key_gen: () => this._r_audit_key(),
    });
    let uiSpec: Record<string, unknown> | null = recipe.ui_spec;
    const uiViolations = new UISchemaValidator().validate(recipe.ui_spec ?? {}, {
      allowed_components: uiAllowedComponents,
      allowed_channels: recipe.ui_allowed_channels,
      allowed_theme_tokens: recipe.ui_allowed_theme_tokens,
    });
    if (uiViolations.length > 0) {
      uiSpec = null;
    }
    const wiring = recipe.tool_wiring!;
    this.introspection_specs = introspection_tool_specs();
    this.self_specs = wiring.self_specs();
    const introspectionNames = new Set(this.introspection_specs.map((s) => s.name));
    const selfNames = new Set(this.self_specs.map((s) => s.name));
    for (const spec of [...this.introspection_specs, ...this.self_specs]) {
      const tags = this._tool_tags[spec.name] ?? new Set<string>();
      tags.add('immutable');
      this._tool_tags[spec.name] = tags;
    }
    this.introspection_service = new IntrospectionService(
      new IntrospectionSources({
        knowledge_set: this.knowledge_set,
        harness_registry: this.harness_registry,
        tools: [],
        ui_spec: uiSpec,
        entity_registry: this.entity_registry as never,
      }),
    );
    this.introspection_pipeline = build_introspection_pipeline(this.introspection_service);
    const introspectionExecutor = make_introspection_executor(this.introspection_service);
    const selfExecutor = wiring.self_executor_factory(
      this.self_pipeline!,
      () => this._self_context(),
    ) as unknown as (
      ctx: unknown,
      spec: ToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ) => Promise<unknown>;
    this.self_pipeline_runner = new ToolPipeline({
      gate: new PermissionGate(),
      extractor: (spec: ToolSpec, _args: Record<string, unknown>) =>
        wiring.self_operation_of(spec),
      executor: selfExecutor as never,
    });
    this.retriever_registry = new RetrieverRegistry();
    this.retriever_registry.register(
      new KnowledgeSetRetriever(() => this.knowledge_set as never),
    );
    for (const factory of recipe.retrieval_sources) {
      this.retriever_registry.register(factory(this) as never);
    }
    const harnessDeclarative = this.harness_registry!.declarative;
    const unifiedExtractor = (
      spec: ToolSpec,
      args: Record<string, unknown>,
    ): [string, string] | null => {
      if (introspectionNames.has(spec.name)) return ['read', '*'];
      if (selfNames.has(spec.name)) return wiring.self_operation_of(spec);
      const definition = harnessDeclarative.definitions[spec.name];
      if (definition === undefined) return null;
      return declarative_operation(definition, args) as [string, string];
    };
    const unifiedExecutor = async (
      ctx: unknown,
      spec: ToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<unknown> => {
      if (introspectionNames.has(spec.name)) {
        return introspectionExecutor(ctx, spec, args, approval as never);
      }
      if (selfNames.has(spec.name)) {
        return selfExecutor(ctx, spec, args, approval);
      }
      return harnessDeclarative.dispatch(ctx, spec, args, approval);
    };
    const unifiedFailureReason = (
      spec: ToolSpec,
      args: Record<string, unknown>,
    ): string | null => {
      const definition = harnessDeclarative.definitions[spec.name];
      if (definition === undefined) return null;
      return declarative_failure_reason(definition, args);
    };
    this.tool_pipeline = new ToolPipeline({
      gate: new PermissionGate(),
      extractor: unifiedExtractor,
      failure_reason: unifiedFailureReason,
      executor: unifiedExecutor as never,
    });
    await this._restore_set_state(recipe);
    if (this.growth_pipeline !== null) {
      (this.growth_pipeline as unknown as { knowledge_set: KnowledgeSet }).knowledge_set =
        this.knowledge_set!;
    }
    await this._restore_baseline();
    await this._restore_thread_tags();
    this.tool_index = new ToolVectorIndex();
    this._rebuild_tool_index();
    this.tool_selector = new ToolSelector({
      max_tools: 18,
      baseline_names: [...this._baseline_names],
    });
    for (const [kind, factory] of Object.entries(recipe.apply_targets)) {
      this.self_pipeline!.register_target(kind as never, factory(this) as never);
    }
    this.meta_tuner = new MetaTuner({ knowledge_set: this.knowledge_set! });
    this.turn_metrics = new TurnMetrics();
    this.pool_governance = new PoolGovernance({
      now: () => this._r_now(),
    });
    const sources = (
      this.introspection_service as unknown as {
        _sources: { tools: unknown; registered_tools: unknown };
      }
    )._sources;
    sources.tools = this.collect_specs();
    sources.registered_tools = this.merged_specs();
    await this.rebuild_engine();
  }
}
