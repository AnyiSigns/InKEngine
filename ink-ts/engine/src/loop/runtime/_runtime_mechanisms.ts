/**
 * Runtime 机制装配段（D01/D02/D08 装配产物）：引擎自承载证据/环境提供器。
 *
 * 装配产物与机制开关一一对应（AssemblyRecipe 机制开关缺省全开；false =
 * 该块不装配）：
 * - 边证据存储：开关开启时以 records 通道持久化（Storage seam 注入，
 *   受控直写——集合非演化资产集合）；关闭 = 内存 store（钩子不注册，
 *   零写零持久化）；
 * - 环境提供器注册表 + 配方环境声明登记 + 经 approval 的 install 入口。
 */

import { approve_before_execute, ApprovalDecision } from '../../gate/approval/approval.js';
import type { ApprovalInterruptContext, InterruptPolicy } from '../../gate/approval/approval.js';
import type { InterruptPolicy as HostPolicyLike } from '../../gate/approval/approval_types.js';
import { emit_audit } from '../../gate/audit_log/audit_log.js';
import { EdgeEvidenceStore, RecordsEdgeEvidenceStorage } from '../../core/edge_evidence/index.js';
import { EnvironmentProviders } from '../../core/environments/providers.js';
import type { EnvironmentSpec } from '../../core/environments/spec.js';
import { EnvironmentHandle } from '../../core/environments/spec.js';
import { ENV_STATUS_READY } from '../../core/environments/constants.js';
import type { Storage } from '../../dock/ports/storage.js';
import {
  EdgeEvidenceSettleHook,
  FailureAuditSettleHook,
  NodeProposalSettleHook,
  PolicyEdgeReviewSettleHook,
  RecommendedPriorSettleHook,
  SettleHooks,
  run_verdict,
  UPDATE_SUCCESS,
  type SettleContext,
} from '../settle/index.js';
import { promotion_signature_key } from '../settle/promotion.js';
import { default_engine_seed_edges } from '../../graph/nodes/index.js';
import { import_seed_paths } from '../settle/index.js';
import { _KnowledgeUsageSettleHook, _LedgerSettleHook } from './_settle.js';
import { RuntimeContexts } from './_runtime_contexts.js';
import type { AssemblyRecipe } from './_types.js';

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

/** 机制装配段（evidence/环境）。 */
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

  /** 机制留痕统一出口（settle 钩子共用；set_audit append-only）。 */
  _mechanism_sink(record: Record<string, unknown>): unknown {
    return _mechanism_audit_record(this as never, record);
  }

  /**
   * 回合沉淀钩子链装配（引擎构建调用）：归因/失败审计/提案/先验晋升/
   * 策略边复审 + 知识归因/回合账本 + growth/实体演化。开关见
   * AssemblyRecipe（settle_hooks_enabled = false 整族关闭；其余按块收敛）。
   */
  _assemble_settle_chain(): SettleHooks {
    const recipe = this._recipe;
    const settleHooks = new SettleHooks();
    const store = this.edge_evidence_store;
    if (recipe !== null && recipe.settle_hooks_enabled) {
      // 引擎默认产出闸门：成功收尾（成功归因方向）即过线——未注入宿主
      // 质量闸门时晋升 fail-closed 前提的保守默认解锁点
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
          new RecommendedPriorSettleHook(store, engineGate, {
            sink: auditSink,
            on_promoted:
              (signature): unknown => {
                (this._pg_promoted as Set<string>).add(promotion_signature_key(signature));
                return null;
              },
          }),
        );
        settleHooks.register(
          new PolicyEdgeReviewSettleHook(store, {
            sink: auditSink,
            persisted_downgraded: this._pg_downgraded,
          }),
        );
      }
      settleHooks.register(new FailureAuditSettleHook({ sink: auditSink }));
    }
    settleHooks.register(new _KnowledgeUsageSettleHook(this));
    settleHooks.register(new _LedgerSettleHook(this));
    // 回合尾段（growth/实体演化/技能结晶/回合记忆抽取/收尾调参）由
    // _runtime_self_learning 层的 _assemble_settle_chain 覆写接续注册。
    return settleHooks;
  }

  /** 边证据装配（引擎自承载持久化；开关关闭 = 内存 store 零持久化）+ 出厂
   *  边先验（P4.2a-3 可喂链 seed_edges：开启时经既有受控通道
   *  import_seed_paths 写入证据面；缺省数据 = 出厂实例匹配的 feed 关系；
   *  已存在同键运行统计不覆盖）。 */
  async _assemble_mechanism_products(guarded: Storage, recipe: AssemblyRecipe): Promise<void> {
    // 证据 store：开关开 = records 通道持久化；关 = 内存 store（零持久化）。
    if (recipe.edge_evidence_enabled) {
      this.edge_evidence_store = new EdgeEvidenceStore(
        new RecordsEdgeEvidenceStorage(guarded),
      );
    } else {
      this.edge_evidence_store = new EdgeEvidenceStore();
    }
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
    this._assemble_environments(guarded, recipe);
  }
}