/**
 * 知识使用归因 settle 钩子 + 回合账本归约 settle 钩子（引擎自接线）。
 *
 * 知识使用归因（runtime.py _KnowledgeUsageSettleHook 移植）：
 * 演化候选的数据源闭环：回合装配注入知识（provide 命中即 record_usage
 * 成功留痕）→ 回合收尾若失败（错误/预算超限/异常终止），对本回合注入的
 * 知识条目补记 record_usage(failed=True, log=...)——失败日志 = 反思式
 * 变异的输入。随后清空回合命中集合（回合边界）。
 *
 * 回合账本归约（引擎每回合自动产出，拍板 = 引擎自接线 ON）：
 * 回合收尾把当轮可归约记录（trace 步骤 + 意图/结论事实）经
 * ledger.merge_ledger 合并出回合账本（确定性摘要），落 ``ledger`` 集合
 * （records 通道普通命名空间，非演化资产集合——直写放行，无需豁免；
 * 键 = thread\u001f回合序号，序号按线程单调），idempotent（同 thread 同
 * round 不重复产出）。时间取 §2 注入的运行时时钟；跨回合连续性 = 上一账本
 * 的 summary 作旧摘要入参（增量摘要链）。
 *
 * 观测侧语义：归因/记账失败只吞异常不阻断 run 结果交付（settle 钩子通用
 * 纪律，core 零日志面）。
 */

import type { KnowledgeSet } from '../knowledge_set/index.js';
import { merge_ledger, type Ledger } from '../ledger/ledger.js';
import { TRACE_FAILED } from '../settle/_constants.js';
import type { SettleContext } from '../settle/types.js';

/** 知识使用归因钩子的运行时访问面（结构契约，避免钩子依赖叶类）。 */
export interface _KnowledgeUsageRuntime {
  readonly _round_knowledge_hits: Set<string>;
  readonly knowledge_set: KnowledgeSet | null;
}

/** 回合账本集合（records 通道普通命名空间；非受守卫演化资产集合）。 */
export const ROUND_LEDGER_COLLECTION = 'ledger';

/** 回合账本数据契约版本（对齐壳侧 round_ledger/1）。 */
export const ROUND_LEDGER_SCHEMA = 'round_ledger/1';

/** 键组分隔符（thread 与回合序号；ASCII 单元分隔符，沿工具标签先例）。 */
const _KEY_SEP = '\u001f';

/** 回合状态字符串取值（非空串才收；其余回落 null）。 */
function _str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

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
  private readonly _runtime: _KnowledgeUsageRuntime;

  constructor(runtime: _KnowledgeUsageRuntime) {
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

// ── 回合账本归约（引擎每回合自动产出）──────────────────────────────────────

/** 当轮可归约事实（merge_ledger 新账本形态：intent/conclusion/events）。 */
export function _round_ledger_facts(ctx: SettleContext): Ledger | null {
  const state = (ctx.result.state ?? {}) as Record<string, unknown>;
  // 事件要点形态对齐 ledger.ledgerText 的读取面（kind + detail）；值全部
  // 为 JSON 标量（枚举/数字/文本），形态即 Ledger
  const events: Array<{
    kind: string;
    detail: { node: string; status: string; tokens: number };
  }> = [];
  for (const step of ctx.steps) {
    events.push({
      kind: step.status === TRACE_FAILED ? 'error' : 'node',
      detail: { node: step.node, status: step.status, tokens: step.tokens },
    });
  }
  const intent = _str(state['input']) ?? _str(state['intent']);
  const conclusion = _str(state['reply']) ?? _str(state['conclusion']);
  const failed = _round_failed(ctx);
  if (intent === null && conclusion === null && events.length === 0 && !failed) {
    return null;
  }
  return { intent, conclusion, events } as Ledger;
}

/** 回合账本钩子的运行时访问面（结构契约，避免钩子依赖叶类）。 */
export interface _LedgerRuntime {
  _r_now(): number;
  _ledger_seq: Record<string, number>;
  _ledger_latest_summary: Record<string, string>;
  _ledger_rounds: Record<string, string>;
  storage: {
    put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void>;
  } | null;
}

/**
 * 回合账本归约钩子（引擎每回合收尾自动接线）：可归约记录 → merge_ledger
 * → 落 ledger 集合（thread\u001f回合序号键）。幂等/有界/确定性见文件头。
 */
export class _LedgerSettleHook {
  readonly #rt: _LedgerRuntime;

  constructor(rt: _LedgerRuntime) {
    this.#rt = rt;
  }

  async settle(ctx: SettleContext): Promise<void> {
    const rt = this.#rt;
    const storage = rt.storage;
    if (storage === null || storage === undefined) return;
    const thread_id = ctx.thread_id || '-';
    const round_id = ctx.round_id ?? '';
    const facts = _round_ledger_facts(ctx);
    if (facts === null) return; // 无记录回合不产出
    if (round_id !== '' && rt._ledger_rounds[thread_id] === round_id) {
      return; // 同 round 幂等（resume/重放不重复产出）
    }
    const seq = (rt._ledger_seq[thread_id] ?? 0) + 1;
    const now = rt._r_now();
    const merged = merge_ledger(rt._ledger_latest_summary[thread_id] ?? null, [facts], {
      now: () => now,
    });
    const key = `${thread_id}${_KEY_SEP}${seq}`;
    try {
      await storage.put_record(ROUND_LEDGER_COLLECTION, key, {
        schema: ROUND_LEDGER_SCHEMA,
        thread_id,
        round_id,
        round_index: seq,
        created_at: now,
        ...facts,
        summary: merged.summary,
        source_count: merged.source_count,
      });
    } catch {
      // 账本落库失败只跳过（观测侧，不阻断 run 结果交付）
      return;
    }
    rt._ledger_seq[thread_id] = seq;
    rt._ledger_latest_summary[thread_id] = merged.summary;
    rt._ledger_rounds[thread_id] = round_id;
  }

  toString(): string {
    return '_LedgerSettleHook';
  }
}
