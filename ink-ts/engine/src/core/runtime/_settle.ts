/**
 * 知识使用归因 settle 钩子（runtime.py _KnowledgeUsageSettleHook 移植）。
 *
 * 演化候选的数据源闭环：回合装配注入知识（provide 命中即 record_usage
 * 成功留痕）→ 回合收尾若失败（错误/预算超限/异常终止），对本回合注入的
 * 知识条目补记 record_usage(failed=True, log=...)——失败日志 = 反思式
 * 变异的输入。随后清空回合命中集合（回合边界）。
 *
 * 观测侧语义：归因失败只吞异常不阻断 run 结果交付（settle 钩子通用纪律，
 * core 零日志面）。
 */

import type { KnowledgeSet } from '../knowledge_set/index.js';
import type { SettleContext } from '../settle/types.js';
import type { Runtime } from './runtime.js';

/** 回合步骤的失败判定（鸭子协议：status/error/note 字段）。 */
type StepLike = {
  status?: string;
  error?: unknown;
  note?: unknown;
};

/** 回合结果（鸭子协议：reason/error/interrupt 字段）。 */
type ResultLike = {
  reason?: unknown;
  error?: unknown;
  interrupt?: unknown;
};

/** 回合失败判定（与证据归因 run_verdict 同语义：有失败结点 / 错误收尾 /
 *  预算截断 = 失败；中断挂起中性不算失败但也不记成功）。 */
export function _round_failed(ctx: SettleContext): boolean {
  const steps = ctx.steps as readonly StepLike[] | null;
  if (steps !== null && steps !== undefined) {
    for (const step of steps) {
      if (step.status === 'failed') return true;
    }
  }
  const reason = (ctx.result as ResultLike | null)?.reason;
  return reason === 'error' || reason === 'budget_exceeded';
}

/** 失败原因摘要（记入失败日志，供进化工厂反思）。 */
export function _round_failure_reason(ctx: SettleContext): string | null {
  const steps = ctx.steps as readonly StepLike[] | null;
  if (steps !== null && steps !== undefined) {
    for (const step of steps) {
      if (step.status === 'failed') {
        const note = step.error ?? step.note;
        if (note) return String(note);
      }
    }
  }
  const error = (ctx.result as ResultLike | null)?.error;
  if (error) return String(error);
  const reason = (ctx.result as ResultLike | null)?.reason;
  return reason ? `回合${String(reason)}` : null;
}

/** 知识使用归因 settle 钩子（见文件头）。 */
export class _KnowledgeUsageSettleHook {
  private readonly _runtime: Runtime;

  constructor(runtime: Runtime) {
    this._runtime = runtime;
  }

  async settle(ctx: SettleContext): Promise<void> {
    const hits = this._runtime._round_knowledge_hits;
    if (hits === null || hits === undefined || hits.size === 0) return;
    const failed = _round_failed(ctx);
    const failed_reason = _round_failure_reason(ctx);
    const ks: KnowledgeSet | null = this._runtime.knowledge_set;
    if (ks !== null) {
      for (const entry_id of [...hits]) {
        try {
          if (failed) {
            ks.record_usage(entry_id, {
              failed: true,
              log: failed_reason ?? '回合失败（知识归因）',
            });
          }
        } catch {
          // 知识失败归因记录失败（忽略）
        }
      }
    }
    hits.clear();
  }

  toString(): string {
    return '_KnowledgeUsageSettleHook';
  }
}
