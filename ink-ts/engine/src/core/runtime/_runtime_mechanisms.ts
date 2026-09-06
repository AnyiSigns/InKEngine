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
import { SOURCE_EVIDENCE, SOURCE_KNOWLEDGE } from '../assembly/index.js';
import { ContextMixer } from '../context/context_mixer.js';
import { ContextSource as ContextSourceImpl, type ContextSource } from '../context/context_types.js';
import { EdgeEvidenceStore, RecordsEdgeEvidenceStorage } from '../edge_evidence/index.js';
import { EnvironmentProviders } from '../environments/providers.js';
import type { EnvironmentSpec } from '../environments/spec.js';
import { EnvironmentHandle } from '../environments/spec.js';
import { ENV_STATUS_READY } from '../environments/constants.js';
import { FingerprintCacheStore, RecordsFingerprintCacheStorage } from '../fingerprint_cache/index.js';
import type { Storage } from '../storage/storage.js';
import { PathAssemblyFlags } from '../contracts/contracts.js';
import { PathAssemblyRuntime } from '../path_assembler/runtime.js';
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
import { _KnowledgeUsageSettleHook, _LedgerSettleHook } from './_settle.js';
import { RuntimeContexts } from './_runtime_contexts.js';
import type { AssemblyRecipe } from './_types.js';
import type { AssemblySourcesProvider } from '../run_result/run_result.js';

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
   * 回合沉淀钩子链装配（rebuild_engine 调用）：六钩子（边证据归集/失败
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
        settleHooks.register(
          new RecommendedPriorSettleHook(store, engineGate, { sink: auditSink }),
        );
        settleHooks.register(new PolicyEdgeReviewSettleHook(store, { sink: auditSink }));
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
        settleHooks.register(
          new PoolGovernanceSettleHook(this.pool_governance, {
            store,
            now: () => this._r_now(),
            audit_sink: auditSink,
            // R3 池治理写回 seam：实体注册表写实现已装配时随钩子注入
            // （见 _runtime_assemble），无 = 仅登记 + 审计（fallback）
            writable: this.pool_governance_writable,
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
      canary_timeout: null,
      canary_options: null,
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
