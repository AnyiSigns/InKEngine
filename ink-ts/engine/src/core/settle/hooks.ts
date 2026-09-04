/**
 * 沉淀钩子接口与归因/审计钩子（注册式扩展：只记录不裁决）。
 *
 * 对标 ink_engine.core.settle 的 SettleHook / SettleHooks /
 * EdgeEvidenceSettleHook / FailureAuditSettleHook：
 * - SettleHooks：注册体（引擎 run 收尾触发；可单块关闭 = 不注册即关闭），
 *   钩子按注册序执行，单钩子异常 = 记录并跳过（沉淀失败不阻断 run 结果）；
 * - EdgeEvidenceSettleHook：归因钩子——轨迹回放 → 按归因规则逐边更新边
 *   证据（零 LLM：成败/成本全部自动归集，不产出决策）；
 * - FailureAuditSettleHook：失败日志留痕审计（append-only；登记形态 = 内存
 *   清单 + 可选落库回调）。
 *
 * 差异说明：Python 侧钩子失败时 logger.warning 留痕；TS core 零 IO/零日志，
 * 以静默收集同一「不阻断」语义（沿 tool_pipeline 等零日志先例）。
 */

import type { EdgeEvidence } from '../edge_evidence/_types.js';
import { EdgeEvidenceStore } from '../edge_evidence/store.js';
import { now } from './_time.js';
import { TRACE_FAILED, UPDATE_SUCCESS } from './_constants.js';
import { attribution_plan, derive_traversals } from './attribution.js';
import { SettleContext, edge_key_str, traversal_edge_key } from './types.js';

/** 沉淀钩子接口（注册式扩展；失败仅记录不阻断主流程）。 */
export interface SettleHook {
  settle(ctx: SettleContext): Promise<void>;
}

/** 结构性协议判定（镜像 Python runtime_checkable Protocol 的 settle 属性检查）。 */
function isSettleHook(hook: unknown): hook is SettleHook {
  if (typeof hook !== 'object' || hook === null) return false;
  return typeof (hook as { settle?: unknown }).settle === 'function';
}

/**
 * 沉淀钩子注册体（引擎 run 收尾触发；可单块关闭 = 不注册即关闭）。
 * 钩子按注册序执行；单个钩子异常 = 跳过（观测不影响执行——沉淀失败不得
 * 污染 run 结果）。
 */
export class SettleHooks {
  readonly #hooks: SettleHook[] = [];

  register(hook: unknown): void {
    if (!isSettleHook(hook)) {
      throw new TypeError(
        `沉淀钩子须实现 SettleHook 协议: ${(hook as { constructor?: { name?: string } })?.constructor?.name ?? typeof hook}`,
      );
    }
    this.#hooks.push(hook);
  }

  get hooks(): readonly SettleHook[] {
    return [...this.#hooks];
  }

  /** 触发全部钩子（返回收集的异常清单；不向调用方抛出）。 */
  async run(ctx: SettleContext): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const hook of this.#hooks) {
      try {
        await hook.settle(ctx);
      } catch (exc) {
        // Python 侧 logger.warning 留痕（忽略）；TS core 零日志 = 静默收集，
        // 沉淀失败不阻断执行
        errors.push(exc);
      }
    }
    return errors;
  }
}

/**
 * 归因钩子：轨迹回放 → 按归因规则逐边更新边证据（纯算法）。
 * 零 LLM：成败/成本全部自动归集；本钩子不产出任何决策。
 */
export class EdgeEvidenceSettleHook implements SettleHook {
  readonly #store: EdgeEvidenceStore;

  constructor(store: EdgeEvidenceStore) {
    this.#store = store;
  }

  async settle(ctx: SettleContext): Promise<void> {
    let evidenceIndex: Map<string, EdgeEvidence> | null = null;
    if (ctx.steps.length > 0 && ctx.steps.some((s) => s.status === TRACE_FAILED)) {
      evidenceIndex = new Map<string, EdgeEvidence>();
      for (const tr of derive_traversals(ctx)) {
        const key = traversal_edge_key(tr, ctx.domain);
        const evidence = await this.#store.get(key);
        if (evidence !== null) {
          evidenceIndex.set(edge_key_str(key), evidence);
        }
      }
    }
    for (const update of attribution_plan(ctx, evidenceIndex)) {
      if (update.kind === UPDATE_SUCCESS) {
        await this.#store.record_success(update.key, {
          cost: update.cost,
          delta: update.delta,
        });
      } else {
        // UPDATE_FAIL：归因计划只产出 success/fail 两种
        await this.#store.record_failure(update.key, {
          cost: update.cost,
          delta: update.delta,
        });
      }
    }
  }
}

/** 失败审计落库回调（记录形态 = 失败事实 dict）。 */
export type AuditSink = (record: Record<string, unknown>) => unknown;

/**
 * 失败日志留痕审计（append-only：记录只增不删，可长期追溯）。
 * 登记形态为内存清单 + 可选落库回调（宿主注入）；本钩子只记录失败事实，
 * 不做任何后续动作。
 */
export class FailureAuditSettleHook implements SettleHook {
  readonly records: Record<string, unknown>[] = [];
  readonly #sink: AuditSink | null;

  constructor(opts: { sink?: AuditSink | null } = {}) {
    this.#sink = opts.sink ?? null;
  }

  async settle(ctx: SettleContext): Promise<void> {
    const ts = now();
    for (const step of ctx.steps) {
      if (step.status !== TRACE_FAILED) {
        continue;
      }
      const record: Record<string, unknown> = {
        ts,
        thread_id: ctx.thread_id,
        round_id: ctx.round_id ?? '',
        trace_id: ctx.trace_id,
        domain: ctx.domain,
        node: step.node,
        graph_path: [...step.graph_path],
        reason: ctx.result.error ?? '节点执行失败',
      };
      this.records.push(record);
      if (this.#sink !== null) {
        this.#sink(record);
      }
    }
  }
}
