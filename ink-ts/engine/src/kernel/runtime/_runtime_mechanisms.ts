// gate: 超限(351 行) - Runtime 机制装配段（evidence/cache/组装运行期/环境/多域同一装配层，拆文件破坏装配产物与开关一一对应关系）
/**
 * Runtime 机制装配段（D01/D02/D08 装配产物）：引擎自承载证据/缓存/组装
 * 运行期/环境提供器/多域调配器。
 *
 * 装配产物与机制开关一一对应（AssemblyRecipe 机制开关缺省全开；false =
 * 该块不装配）：
 * - 边证据存储：开关开启时以 records 通道持久化（Storage seam 注入，
 *   受控直写——集合非演化资产集合）；关闭 = 内存 store（钩子不注册，
 *   零写零持久化）；
 * - 指纹缓存 store（fingerprint_cache_enabled）；
 * - 组装运行期挂载（set_default_assembly_runtime；assembler_enabled）——
 *   多径展开常态取用的默认运行期（evidence + cache + canary 门经配方）；
 * - 环境提供器注册表 + 配方环境声明登记 + 经 approval 的 install 入口；
 * - context 多域调配器（context_window_multidomain）注册并用于装配源的
 *   多域输入混合。
 */

import { approve_before_execute, ApprovalDecision } from '../approval/approval.js';
import type { ApprovalInterruptContext, InterruptPolicy } from '../approval/approval.js';
import type { InterruptPolicy as HostPolicyLike } from '../approval/approval_types.js';
import { emit_audit } from '../audit_log/audit_log.js';
import { SOURCE_EVIDENCE, SOURCE_KNOWLEDGE } from '../../core/assembly/index.js';
import { ContextMixer } from '../../core/context/context_mixer.js';
import { ContextSource as ContextSourceImpl, type ContextSource } from '../../core/context/context_types.js';
import { EdgeEvidenceStore, RecordsEdgeEvidenceStorage } from '../../core/edge_evidence/index.js';
import { EnvironmentProviders } from '../../core/environments/providers.js';
import type { EnvironmentSpec } from '../../core/environments/spec.js';
import { EnvironmentHandle } from '../../core/environments/spec.js';
import { ENV_STATUS_READY } from '../../core/environments/constants.js';
import { FingerprintCacheStore, RecordsFingerprintCacheStorage } from '../../core/fingerprint_cache/index.js';
import type { Storage } from '../../core/storage/storage.js';
import { PathAssemblyFlags } from '../../core/contracts/contracts.js';
import { PathAssemblyRuntime } from '../path_assembler/runtime.js';
import type { ExplorationBudgetOptions } from '../path_assembler/_assembler_cache.js';
import type { AssemblyRequest } from '../path_assembler/types.js';
import { KIND_PATH, type KnowledgeSet } from '../../core/knowledge_set/index.js';
import { knowledge_entry_to_skill, type SkillEntry } from '../skill_crystal/index.js';
import { set_default_assembly_runtime } from '../path_assembler/module_runtime.js';
import {
  EdgeEvidenceSettleHook,
  FailureAuditSettleHook,
  FingerprintSettleHook,
  NodeProposalSettleHook,
  PolicyEdgeReviewSettleHook,
  PoolGovernanceSettleHook,
  RecommendedPriorSettleHook,
  SettleHooks,
  run_verdict,
  UPDATE_SUCCESS,
  type SettleContext,
} from '../settle/index.js';
import { promotion_signature_key } from '../settle/promotion.js';
import { registration_output_fields } from '../../core/node_registry/index.js';
import { default_engine_seed_edges } from '../../core/nodes/index.js';
import { import_seed_paths } from '../settle/index.js';
import { _KnowledgeUsageSettleHook, _LedgerSettleHook } from './_settle.js';
import { RuntimeContexts } from './_runtime_contexts.js';
import type { AssemblyRecipe } from './_types.js';
import type { AssemblySourcesProvider } from '../../core/run_result/run_result.js';

/** 环境安装审批 key 前缀（与补丁审批 key 分离；策略按需直过）。 */
export const ENV_INSTALL_KEY_PREFIX = 'env.install';

/** 机制审计留痕（set_audit append-only；失败不阻断主流程）。 */
export function _mechanism_audit_record(rt: {
  storage: Storage | null;
  _r_now(): number;
  _r_audit_key(): string;
}, record: Record<string, unknown>): unknown {
  if (rt.storage === null) return null;
  try {
    return emit_audit(rt.storage, { ...record }, {
      now: () => rt._r_now(),
      keyGen: () => rt._r_audit_key(),
    });
  } catch {
    return null;
  }
}

/** 技能先验回灌上限（同名取最新版本后的候选条数；防组装候选被技能淹没）。 */
const _SKILL_PRIOR_LIMIT = 4;
/** 技能先验跨域回落上限（请求域精确匹配无命中 → 回落 general 域的候选条数；
 *  独立于精确命中 cap（≤ 精确上限）= 防跨域先验噪声进入非相关任务）。 */
const _SKILL_PRIOR_FALLBACK_LIMIT = 2;
/** 技能回落目标域（技能先验的 general 回落约定；域取值约定随结晶侧
 *  = 指纹缓存条目的上下文域，见 crystallize 的 domain 来源，无预置层级）。
 *  回落 ≠ 组装兜底：先验落空仍由终态候选兜底 seam 出图（见
 *  _mount_assembly_runtime.terminal_types）。 */
const _SKILL_GENERAL_DOMAIN = 'general';

/** 域内 kind=path 技能候选（同名取最新版本；按可信度→版本降序；cap 条数）。
 *  domain = 精确目标域或回落域（general），与结晶侧 domain 字段同值口径。 */
function _skill_prior_ranked(
  ks: KnowledgeSet,
  domain: string,
  limit: number,
): SkillEntry[] {
  const latest = new Map<string, { skill: SkillEntry; credibility: number }>();
  for (const entry of ks.entries()) {
    if (entry.kind !== KIND_PATH) continue;
    let skill: SkillEntry;
    try {
      skill = knowledge_entry_to_skill(entry);
    } catch {
      continue;
    }
    if (skill.domain !== domain) continue;
    const existing = latest.get(skill.name);
    if (existing !== undefined && existing.skill.version >= skill.version) continue;
    latest.set(skill.name, { skill, credibility: entry.credibility });
  }
  const ranked = [...latest.values()].sort(
    (a, b) => b.credibility - a.credibility || b.skill.version - a.skill.version,
  );
  return ranked.slice(0, limit).map((row) => row.skill);
}

/** 配方 → P4.1 候选层探索预算（引擎默认保守关闭：两开关均关 = null = 纯证据
 *  序零漂移；任一开启 = 携带对应开关位与参数覆写——参数未配 = 引擎钉死缺省，
 *  由组装器消费侧钳制，见 PathAssemblerBase 构造）。 */
function _assembly_exploration_budget(recipe: AssemblyRecipe): ExplorationBudgetOptions | null {
  if (!recipe.candidate_trial_enabled && !recipe.anti_monopoly_enabled) return null;
  const budget: ExplorationBudgetOptions = {};
  if (recipe.candidate_trial_enabled) {
    budget.candidate_trial_enabled = true;
    if (recipe.candidate_trial_epsilon !== null && Number.isFinite(recipe.candidate_trial_epsilon)) {
      budget.candidate_trial_epsilon = Math.max(0, recipe.candidate_trial_epsilon);
    }
  }
  if (recipe.anti_monopoly_enabled) {
    budget.anti_monopoly_enabled = true;
    if (recipe.anti_monopoly_window !== null && Number.isFinite(recipe.anti_monopoly_window)) {
      budget.anti_monopoly_window = Math.max(1, Math.trunc(recipe.anti_monopoly_window));
    }
  }
  return budget;
}

/** 机制装配段（evidence/cache/组装运行期/环境/多域调配器）。 */
export abstract class RuntimeMechanisms extends RuntimeContexts {
  /** 配方环境声明（name → spec；install 入口据此解析）。 */
  _environment_specs: Record<string, EnvironmentSpec> = {};

  /** 配方环境声明登记 + 提供器注册表装配（幂等；启动装配调用一次）。 */
  _assemble_environments(_guarded: Storage, recipe: AssemblyRecipe): void {
    const providers = new EnvironmentProviders();
    this.environment_providers = providers;
    const specs: Record<string, EnvironmentSpec> = {};
    for (const spec of recipe.environment_specs) specs[spec.name] = spec;
    this._environment_specs = specs;
  }

  /**
   * 环境 install 入口（经 approval 的受控路径）：配方声明的环境按运行时
   * 类别解析提供器；审批通过（accept/auto）后 ensure（幂等已就绪复用）。
   * ctx 为节点审批上下文（缺省 = 未在 run 内，策略直过才放行，fail-closed）。
   */
  async install_environment(
    name: string,
    opts: { ctx?: ApprovalInterruptContext | null } = {},
  ): Promise<EnvironmentHandle> {
    const providers = this.environment_providers;
    const spec = this._environment_specs[name];
    if (providers === null || spec === undefined) {
      throw new Error(`环境未声明: ${name}（配方 environment_specs 缺该环境）`);
    }
    const provider = providers.get(spec.runtime);
    const policy = this._host_policy as HostPolicyLike | null;
    const key = `${ENV_INSTALL_KEY_PREFIX}.${name}`;
    const action: Record<string, unknown> = {
      tool: 'environment.install',
      name,
      runtime: spec.runtime,
      tools: [...spec.tools],
      summary: `安装环境 ${name}（${spec.runtime}）`,
    };
    let decision: ApprovalDecision;
    if (opts.ctx !== null && opts.ctx !== undefined) {
      decision = await approve_before_execute(
        opts.ctx,
        key,
        action,
        null,
        (policy as unknown as InterruptPolicy) ?? null,
        { clock: () => this._r_now() },
      );
    } else if (policy !== null && policy.should_approve(key, action)) {
      throw new Error(`环境安装需审批上下文（无节点 ctx，策略未直过）: ${name}`);
    } else {
      decision = new ApprovalDecision('auto', action, null, null, 'policy');
    }
    if (decision.decision === 'reject' || decision.decision === 'terminate') {
      throw new Error(`环境安装未获批准（${decision.decision}）: ${name}`);
    }
    const handle = await provider.ensure(spec);
    if (handle.status !== ENV_STATUS_READY) {
      throw new Error(`环境安装未就绪（${handle.status}）: ${name}${handle.error ? ` — ${handle.error}` : ''}`);
    }
    _mechanism_audit_record(this as never, {
      kind: 'environment_install',
      env: name,
      runtime: spec.runtime,
      decision: decision.decision,
      ts: this._r_now(),
    });
    return handle;
  }

  /** 已声明环境名（观察侧；配方 + 运行时声明面）。 */
  environment_names(): readonly string[] {
    return Object.keys(this._environment_specs);
  }

  /** 机制留痕统一出口（settle 钩子/组装运行期共用；set_audit append-only）。 */
  _mechanism_sink(record: Record<string, unknown>): unknown {
    return _mechanism_audit_record(this as never, record);
  }

  /**
   * 回合沉淀钩子链装配（回合引擎构建调用）：六钩子（边证据归集/失败
   * 审计/指纹缓存/失败点提案/推荐先验晋升/策略边复审）+ 池治理 + 知识归因/
   * 回合账本 + growth/实体演化。开关见 AssemblyRecipe（settle_hooks_enabled
   * = false 整族关闭；其余开关按块收敛）。
   */
  _assemble_settle_chain(): SettleHooks {
    const recipe = this._recipe;
    const settleHooks = new SettleHooks();
    const store = this.edge_evidence_store;
    if (recipe !== null && recipe.settle_hooks_enabled) {
      // 引擎默认产出闸门：成功收尾（成功归因方向）即过线——未注入宿主
      // 质量闸门时指纹/晋升 fail-closed 前提的保守默认解锁点
      const engineGate = {
        evaluate: (ctx: SettleContext): boolean =>
          run_verdict(ctx) === UPDATE_SUCCESS && ctx.steps.length > 0,
      };
      const auditSink = (record: Record<string, unknown>): unknown =>
        this._mechanism_sink(record);
      if (recipe.edge_evidence_enabled && store !== null) {
        settleHooks.register(new EdgeEvidenceSettleHook(store));
        settleHooks.register(new NodeProposalSettleHook(store, { proposal_sink: auditSink }));
        const state = this.pool_governance_state;
        settleHooks.register(
          new RecommendedPriorSettleHook(store, engineGate, {
            sink: auditSink,
            // 晋升签名持久化：装配期恢复去重键，每次新晋升幂等落 records
            persisted_signatures: this._pg_promoted,
            on_promoted:
              state !== null
                ? (signature): unknown => {
                    const key = promotion_signature_key(signature);
                    (this._pg_promoted as Set<string>).add(key);
                    return state.mark_promoted(key);
                  }
                : null,
          }),
        );
        settleHooks.register(
          new PolicyEdgeReviewSettleHook(store, {
            sink: auditSink,
            // 复审降级签名持久化：重启后不重复提请（边证据 policy=false 亦
            // 持久，双保险）
            persisted_downgraded: this._pg_downgraded,
            on_downgraded:
              state !== null
                ? (key): unknown => {
                    (this._pg_downgraded as Set<string>).add(key);
                    return state.mark_downgraded(key);
                  }
                : null,
          }),
        );
      }
      settleHooks.register(new FailureAuditSettleHook({ sink: auditSink }));
      if (
        recipe.edge_evidence_enabled
        && recipe.fingerprint_cache_enabled
        && store !== null
        && this.fingerprint_cache_store !== null
      ) {
        settleHooks.register(
          new FingerprintSettleHook(this.fingerprint_cache_store, engineGate, store, {
            context_fingerprint: () =>
              this.assembly_runtime !== null
                ? this.assembly_runtime.last_request_fingerprint
                : null,
          }),
        );
      }
      if (recipe.pool_governance_enabled && this.pool_governance !== null) {
        const registryStore = this.node_registry_store;
        settleHooks.register(
          new PoolGovernanceSettleHook(this.pool_governance, {
            store,
            now: () => this._r_now(),
            audit_sink: auditSink,
            // 候选结点类型产出字段（契约池数据视图）：登记行契约 output_schema
            // 字段名——合并判定与死结点判定的字段面
            node_fields:
              registryStore !== null
                ? (node_type): readonly string[] => {
                    const reg = registryStore.get(node_type);
                    return reg === null ? [] : registration_output_fields(reg);
                  }
                : null,
            // 池不变式输入：池成员是否 active 终态候选（登记行 flags.terminal）；
            // 死结点淘汰不得移除最后一个 active 终态候选（规则内保护分支）。
            terminal_of:
              registryStore !== null
                ? (node_type): boolean => {
                    const reg = registryStore.get(node_type);
                    return reg !== null && reg.is_active() && reg.flags?.terminal === true;
                  }
                : null,
            // A3 池治理写回 seam：结点类型登记 store 受控写实现已装配时随钩子
            // 注入（见 _runtime_assemble），无 = 仅登记 + 审计（fallback）
            writable: this.pool_governance_writable,
            // 治理状态持久化（周预算/去重 records；未装配 = 进程内存回落）
            state: this.pool_governance_state,
          }),
        );
      }
    }
    settleHooks.register(new _KnowledgeUsageSettleHook(this));
    settleHooks.register(new _LedgerSettleHook(this));
    // 回合尾段（growth/实体演化/技能结晶/回合记忆抽取/收尾调参）由
    // _runtime_self_learning 层的 _assemble_settle_chain 覆写接续注册。
    return settleHooks;
  }

  /** 边证据/指纹缓存/多域调配器装配（引擎自承载持久化；开关关闭 = 不装配）。 */
  async _assemble_mechanism_products(guarded: Storage, recipe: AssemblyRecipe): Promise<void> {
    // 证据 store：开关开 = records 通道持久化；关 = 内存 store（零持久化）。
    if (recipe.edge_evidence_enabled) {
      this.edge_evidence_store = new EdgeEvidenceStore(
        new RecordsEdgeEvidenceStorage(guarded),
      );
    } else {
      this.edge_evidence_store = new EdgeEvidenceStore();
    }
    // 出厂边先验（P4.2a-3 可喂链 seed_edges）：开关开启时经既有受控通道
    // import_seed_paths 写入证据面（缺省数据 = 出厂实例匹配的 feed 关系；
    // 已存在同键运行统计不覆盖）。缺省关闭 = 出厂先验不入证据面，组装行为
    // 零漂移；先验写入失败只跳过（数据资产不击穿启动）。
    if (
      recipe.seed_edges_enabled
      && recipe.edge_evidence_enabled
      && this.edge_evidence_store !== null
      && this.edge_evidence_store !== undefined
    ) {
      const raw =
        recipe.seed_edges !== null && recipe.seed_edges !== undefined
          ? recipe.seed_edges
          : default_engine_seed_edges();
      if (raw.length > 0) {
        try {
          await import_seed_paths(
            this.edge_evidence_store,
            raw as readonly Record<string, unknown>[],
          );
        } catch {
          // 出厂边先验写入失败只跳过（数据资产不击穿启动）
        }
      }
    }
    // 指纹缓存 store：开关开才装配（FingerprintSettleHook 按开关注册）。
    if (recipe.fingerprint_cache_enabled) {
      this.fingerprint_cache_store = new FingerprintCacheStore({
        storage: new RecordsFingerprintCacheStorage(guarded),
        now: this._r_now(),
      });
    } else {
      this.fingerprint_cache_store = null;
    }
    // context 多域调配器：开关开 = 注册实例并参与装配源多域混合。
    this.context_mixer = recipe.context_window_multidomain ? new ContextMixer() : null;
    this._assemble_environments(guarded, recipe);
  }

  /** 技能先验提供器（知识集 kind=path → SkillEntry；PathAssemblyRuntime
   *  挂载注入，组装先例层消费——终结「结晶只写不读」）。读取实时知识集
   *  （恢复替换实例后仍命中最新）；请求域精确匹配（同名取最新版本并 cap
   *  条数）；精确命中为空时回落到 domain=general 条目（独立回落上限防跨域
   *  噪声；来源经候选域比对标记为跨域先验）；请求域自身为 general/未指定
   *  时精确域即回落域，跳过回落防重复。回落 ≠ 组装兜底：先验落空仍由
   *  终态候选 seam 出图（见 _mount_assembly_runtime.terminal_types）。
   *  skill_crystal_enabled=false / 知识集未装配 = 不提供。 */
  _skill_prior_provider(): ((request: AssemblyRequest) => Promise<readonly unknown[]>) | null {
    const recipe = this._recipe;
    if (recipe === null || !recipe.skill_crystal_enabled || this.knowledge_set === null) {
      return null;
    }
    return async (request: AssemblyRequest): Promise<readonly unknown[]> => {
      const ks = this.knowledge_set;
      if (ks === null) return [];
      const domain = request.domain;
      const exact = _skill_prior_ranked(ks, domain, _SKILL_PRIOR_LIMIT);
      // 请求域未指定/为 general 时精确域即回落域，跳过回落防重复
      if (exact.length > 0 || domain === '' || domain === _SKILL_GENERAL_DOMAIN) return exact;
      return _skill_prior_ranked(ks, _SKILL_GENERAL_DOMAIN, _SKILL_PRIOR_FALLBACK_LIMIT);
    };
  }

  /** 池实例缺省 config 快照（active 登记行 config_defaults → 类型键映射；
   *  组装候选图绑定执行体用；装配期取一次）。 */
  private _registration_instance_configs(): Record<string, Record<string, unknown>> {
    const store = this.node_registry_store;
    const out: Record<string, Record<string, unknown>> = {};
    if (store === null) return out;
    for (const reg of store.active()) {
      out[reg.type_name] = { ...reg.config_defaults };
    }
    return out;
  }

  /**
   * 组装运行期挂载（boot/装配末段调用）：evidence/cache/开关经配方注入
   * 默认运行期，多径展开常态取用（未挂载 = null = 零证据零缓存零审计）。
   * assembler_enabled=false 或配方缺注册表 = 显式卸载（零生效）。
   * 配方开关先解析为 PathAssemblyFlags（引擎装配状态的按位单一形态，含
   * contract_enabled 语义位），再逐位消费：assembler_enabled 决定挂载、
   * contract_enabled 随运行期进组装器（关闭 = 路径组装不携带契约语义）、
   * multipath_enabled 位 = run_options 执行面开关的位镜像。
   */
  _mount_assembly_runtime(recipe: AssemblyRecipe): void {
    const multipath = Boolean(
      recipe.run_options && (recipe.run_options as { multipath_enabled?: boolean }).multipath_enabled,
    );
    const flags = new PathAssemblyFlags({
      contract_enabled: recipe.contract_enabled,
      edge_evidence_enabled: recipe.edge_evidence_enabled,
      settle_hooks_enabled: recipe.settle_hooks_enabled,
      pool_governance_enabled: recipe.pool_governance_enabled,
      assembler_enabled: recipe.assembler_enabled,
      multipath_enabled: multipath,
      fingerprint_cache_enabled: recipe.fingerprint_cache_enabled,
    });
    this.assembly_flags = flags;
    const registries = this.graph_registries;
    if (!flags.assembler_enabled || registries === null) {
      set_default_assembly_runtime(null);
      this.assembly_runtime = null;
      return;
    }
    const config = flags.as_path_assembly_config();
    const runtime = new PathAssemblyRuntime({
      registry: registries.nodes,
      evidence_store: this.edge_evidence_store,
      retriever: null,
      config,
      sink: (record) => _mechanism_audit_record(this as never, record),
      now: this._r_now(),
      canary: recipe.canary_verification,
      cache: this.fingerprint_cache_store,
      multipath_enabled: multipath,
      contract_enabled: flags.contract_enabled,
      // 池实例缺省 config（登记行 config_defaults 快照；P4.2a-3 组装候选图
      // 按实例 config 绑定执行体——llm_planner/reviewer/main 等实例分化
      // 在真实执行时生效）。登记行后续变动（治理/新登记）经下一次装配生效。
      instance_configs: this._registration_instance_configs(),
      // 技能先验接入组装（决策5：自学习沉淀的 kind=path 技能作为组装候选源；
      // B5：请求域无命中回落 general 域条目 = 跨域先验，非组装兜底）
      skill_provider: this._skill_prior_provider(),
      // 终态候选源（组装零候选兜底）：从运行时结点类型注册表（登记行
      // status=active）选 flags.terminal=true 的类型名清单；组装器从中挑
      // 入池合法者出单节点图（entry=exit=该类型，0 边）。数据面 = 登记行
      // 声明（引擎内置池种子 llm_decider flags.terminal=true），不读任何
      // 整图模板；取不到任何可自终止终态候选 = 组装显式“无候选”，不臆造
      // 图、不回落到旧整图模板。执行体未注册（登记但绑定缺失）的类型不
      // 入候选（池不可执行 = 不可自终止）。
      terminal_types: async (): Promise<readonly string[]> => {
        const store = this.node_registry_store;
        if (store === null) return [];
        const active: string[] = [];
        for (const reg of store.active()) {
          if (reg.flags?.terminal !== true) continue;
          if (registries.nodes.has(reg.type_name)) active.push(reg.type_name);
        }
        return active;
      },
      canary_timeout: null,
      canary_options: null,
      exploration_budget: _assembly_exploration_budget(recipe),
    });
    this.assembly_runtime = runtime;
    set_default_assembly_runtime(runtime);
  }

  /**
   * 装配源提供者（多域调配消费点）：开关开启时装配源清单按域分组经
   * context_mixer 混合；开关关闭/非多域装配 = 基座直通。
   */
  override _assembly_sources(): AssemblySourcesProvider {
    const base = super._assembly_sources();
    if (this.context_mixer === null) return base;
    return async (ctx) => {
      const supplied = await base(ctx);
      if (supplied.length < 2) return supplied;
      const looksLikeSources = supplied.every(
        (s) =>
          s !== null
          && typeof s === 'object'
          && !Array.isArray(s)
          && typeof (s as ContextSource).type === 'string'
          && typeof (s as ContextSource).content === 'string',
      );
      if (!looksLikeSources) return supplied;
      return this._mix_domain_sources(supplied as readonly ContextSource[]);
    };
  }

  /**
   * 多域输入混合：装配源清单按 meta.domain 分组，各组经多域调配器
   * （ContextMixer）确定性组装为单源后并入返回清单。开关关闭/无多域
   * 分组 = 原清单直通（单域/无域装配不引入额外混合语义）。
   */
  async _mix_domain_sources(
    sources: readonly ContextSource[],
  ): Promise<readonly ContextSource[]> {
    const mixer = this.context_mixer;
    if (mixer === null || sources.length < 2) return sources;
    const groups = new Map<string, ContextSource[]>();
    for (const source of sources) {
      const domain = String((source.meta ?? {})['domain'] ?? '');
      if (domain === '') return sources; // 无域标注源 = 非多域装配，直通
      const group = groups.get(domain);
      if (group === undefined) groups.set(domain, [source]);
      else group.push(source);
    }
    if (groups.size < 2) return sources;
    const mixed: ContextSource[] = [];
    for (const [domain, group] of groups) {
      const assembled = await mixer.mix(group, { total_chars: 8000 });
      const kind = group[0]!.type;
      mixed.push(
        new ContextSourceImpl(
          kind === SOURCE_EVIDENCE ? SOURCE_EVIDENCE : SOURCE_KNOWLEDGE,
          assembled.text,
          {
            title: `域混合：${domain}`,
            weight: 1.0,
            relevance: 0.8,
            priority: 6,
            meta: { domain, mixed: true },
          },
        ),
      );
    }
    return mixed;
  }
}
