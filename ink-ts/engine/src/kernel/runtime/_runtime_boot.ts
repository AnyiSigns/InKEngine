// gate: 超限(371 行) - Runtime 装配段（①–⑮ 单一装配序，拆文件破坏步骤顺序可读性）
/**
 * Runtime 装配（runtime.py ``_assemble`` 移植）：装配步骤 ①–⑰——存储/注册表/
 * 种子/成长管线/harness/事件类型/实体/校验器/自指管线/界面/元工具/检索源/
 * 统一流水线/集状态恢复/常驻集/工具索引/apply 目标/调参/引擎重建。
 * MCP 管理器与默认 embedder 为宿主装配面（未迁 core）：mcp seam 未注入即
 * 不启用；ToolVectorIndex 以关键词基线构建。
 */
import { PermissionGate } from '../permissions/permissions.js';
import { ALL_MECHANISM_CONTRACTS, seal_mechanism_registry } from '../registry/index.js';
import type { InterruptPolicy } from '../approval/approval.js';
import { register_perception_nodes } from '../../model/perception/perception.js';
import { default_engine_pool_seed } from '../../graph/nodes/index.js';
import { RuntimeNodeRegistrar } from './_runtime_node_registry.js';
import { EventTypeRegistry } from '../../model/event_types/registry.js';
import {
  event_types_collection,
  EventTypeSpec,
} from '../../model/event_types/eventTypeSpec.js';
import {
  EntityRegistry,
  entity_collection,
} from '../../core/entities/entities.js';
import { DefaultEvolutionWriter } from '../evolution_writer/evolution_writer.js';
import {
  harness_collection,
  HarnessRegistry,
  HarnessRepository,
} from '../../core/harness/index.js';
import {
  IntrospectionService,
  IntrospectionSources,
  introspection_tool_specs,
  make_introspection_executor,
} from '../introspection/index.js';
import { GrowthPipeline } from '../growth/index.js';
import { KnowledgeSet, seed_knowledge_set } from '../../core/knowledge_set/index.js';
import { seed_general } from '../../model/seeds/seeds.js';
import {
  declarative_failure_reason,
  declarative_operation,
} from '../../core/declarative_tools/index.js';
import { EntityEvolutionPipeline } from '../entity_evolution/index.js';
import { GuardedStorage, SelfApplicationPipeline } from '../self_application/index.js';
import { GraphRegistries } from '../../graph/registry/registry.js';
import { ProposalValidator } from '../self_proposal/index.js';
import { MetaTuner, TurnMetrics } from '../tuning/index.js';
import { KnowledgeSetRetriever, RetrieverRegistry } from '../../core/retrieval/index.js';
import { ToolPipeline } from '../tool_pipeline/tool_pipeline.js';
import { ToolSelector } from '../../core/tool_orchestrator/tool_orchestrator.js';
import { ToolVectorIndex } from '../../core/tool_index/tool_index.js';
import { ToolVetting } from '../tool_vetting/tool_vetting.js';
import { UISchemaValidator } from '../../model/ui_schema/uiSchema.js';
import type { ToolSpec } from '../llm/tools.js';
import type { Host, AssemblyRecipe } from './_types.js';
import { _uuid_hex } from './_runtime_base.js';
import { _RoundStepsRecorder } from './_round_steps_recorder.js';
/** 装配基座（步骤 ①–⑰ 实现；boot 失败清理见状态机层）。 */
export abstract class RuntimeBoot extends RuntimeNodeRegistrar {
  protected async _assemble(host: Host, recipe: AssemblyRecipe): Promise<void> {
    // 装配密封（boot 静态门禁）：全量机制契约 DAG 校验（依赖单向/装配完整/
    // 循环拒绝）失败即抛错——半装配/带环依赖的运行时不允许进入装配流程。
    // 密封纯静态（契约 const + Tarjan/topo），零 IO 零副作用。
    seal_mechanism_registry(ALL_MECHANISM_CONTRACTS);
    const rawStorage = await host.create_storage();
    const guardToken = _uuid_hex();
    const guarded = new GuardedStorage(rawStorage, { guard_token: guardToken });
    this.storage = guarded;
    this.guard_token = guardToken;
    this.graph_registries = new GraphRegistries();
    try {
      register_perception_nodes(this.graph_registries.nodes);
    } catch {
      // 感知结点登记失败只跳过（视觉结点缺装配 = 该能力不启用，不击穿 boot）
    }
    // 引擎内置基础节点池种子声明（出厂默认；宿主可经配方 pool_seed 覆写）。
    // 结点类型执行体注册改为声明式注册表恢复（_assemble_node_registry 在
    // mechanism writer 就绪后落登记/恢复，见该步注释）——这里只解析种子数据。
    const poolSeed = recipe.pool_seed ?? default_engine_pool_seed();
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
    // 回合步骤记录器（引擎自接线状态跨引擎重建持有）
    this.round_steps_recorder = new _RoundStepsRecorder();
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
    // 声明式结点类型注册表：持久登记恢复 + 缺省种子补登记 + active 登记重建
    // 运行时执行体注册表（受控写通道经 EvolutionWriter，守卫集合
    // node_registry:<set>）
    await this._assemble_node_registry(guarded, recipe, poolSeed);
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
      { now: () => this._r_now() },
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
    this.vetting = new ToolVetting();
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
    // 统一工具流水线权限门禁 = 装配配置（配方 tool_gate；缺省 = 引擎默认
    // DENY 兜底无 review 档——现行为不变）；审批策略 = 宿主 interrupt_policy
    // 活读面（autoApprove/直过名单语义随卡走，fail-closed 全挂起为缺省）
    const toolGate =
      recipe.tool_gate !== null && recipe.tool_gate !== undefined
        ? recipe.tool_gate.to_gate()
        : new PermissionGate();
    const pipelinePolicy = this._host_policy as InterruptPolicy | null;
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
      gate: toolGate,
      extractor: unifiedExtractor,
      failure_reason: unifiedFailureReason,
      executor: unifiedExecutor as never,
      approval_policy: pipelinePolicy,
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
    const sources = (
      this.introspection_service as unknown as {
        _sources: { tools: unknown; registered_tools: unknown };
      }
    )._sources;
    sources.tools = this.collect_specs();
    sources.registered_tools = this.merged_specs();
    // 引擎自承载装配产物（evidence/环境）→ 自学习族（记忆/技能容器）
    await this._assemble_mechanism_products(guarded, recipe);
    await this._assemble_self_learning(guarded, recipe);
    await this.rebuild_engine();
  }
}
