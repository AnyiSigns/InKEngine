/**
 * 回合记忆抽取 settle 钩子（D04.1 接线）：回合收尾把当轮账本事实规则抽取
 * 入 memory 域。
 *
 * 触发语义 = 每回合收尾一次（settle 链在账本归约之后）；抽取输入为当轮
 * 账本事实（intent/conclusion/确认类事件），由 runtime 装配注入 facts
 * 提供者（含决议事件并入——accept/reject/edit 有真实输入非永远空转）。
 * 写入经 StorageBackedMemoryStore（EvolutionWriter kind=memory 受控通道）。
 *
 * 幂等：同 thread 同 round 只抽取一次（账本恢复/同轮多次 settle 不重复）；
 * 冲突消解/去重语义沿用 memory_extract.arbitrate_and_store（新旧并存留痕）。
 * 失败只跳过（观测侧，不阻断 run 结果交付）。
 */

import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import { StorageBackedMemoryStore } from '../memory/index.js';
import type { SettleContext } from '../settle/index.js';
import {
  DEFAULT_NAMESPACE,
  PRIORITY_CONCLUSION,
  PRIORITY_CONFIRMATION,
  PRIORITY_INTENT,
  arbitrate_and_store,
  extract_entries_from_ledger,
} from './memory_extract.js';

/** 当轮账本事实提供者（settle 钩子不感知账本归约实现，由装配侧注入）。 */
export type LedgerFactsProvider = (
  ctx: SettleContext,
) => JsonRecord | Record<string, unknown> | null;

/** MemoryExtractSettleHook 构造选项（命名空间/优先级/事实提供者）。 */
export interface MemoryExtractSettleHookOptions {
  namespace?: string;
  priority_confirmation?: number;
  priority_intent?: number;
  priority_conclusion?: number;
  /** 当轮账本事实提供者（缺省 = 从 ctx 宽松读取账本形记录；runtime 注入
   *  实际归约产物）。 */
  facts?: LedgerFactsProvider | null;
}

/** 回合事实的宽松读取（镜像 ledger 归约读取面：intent/conclusion/events）。 */
function _ctx_ledger_like(ctx: SettleContext): JsonRecord | null {
  const state = isRecord(ctx.result.state) ? ctx.result.state : {};
  const events: unknown[] = [];
  for (const step of ctx.steps) {
    events.push({
      kind: 'node',
      detail: { node: step.node, status: step.status },
    });
  }
  const ledger: Record<string, unknown> = { round_id: ctx.round_id, events };
  if (typeof state['input'] === 'string' && state['input'] !== '') {
    ledger['intent'] = state['input'];
  }
  if (typeof state['reply'] === 'string' && state['reply'] !== '') {
    ledger['conclusion'] = state['reply'];
  }
  if (Object.keys(ledger).length <= 2) return null;
  return ledger as unknown as JsonRecord;
}

/**
 * 回合记忆抽取 settle 钩子（引擎默认装配；同 thread+round 幂等）。
 */
export class MemoryExtractSettleHook {
  readonly #store: StorageBackedMemoryStore;
  readonly #facts: LedgerFactsProvider;
  readonly #namespace: string;
  readonly #priority_confirmation: number;
  readonly #priority_intent: number;
  readonly #priority_conclusion: number;
  // 已抽取回合（thread → round_id）：账本同 round 幂等，记忆抽取同口径
  readonly #extracted_rounds: Map<string, string> = new Map();

  constructor(
    store: StorageBackedMemoryStore,
    options: MemoryExtractSettleHookOptions = {},
  ) {
    this.#store = store;
    this.#facts = options.facts ?? _ctx_ledger_like;
    this.#namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.#priority_confirmation =
      options.priority_confirmation ?? PRIORITY_CONFIRMATION;
    this.#priority_intent = options.priority_intent ?? PRIORITY_INTENT;
    this.#priority_conclusion = options.priority_conclusion ?? PRIORITY_CONCLUSION;
  }

  async settle(ctx: SettleContext): Promise<void> {
    const thread_id = ctx.thread_id || '-';
    const round_id = ctx.round_id ?? '';
    if (round_id !== '' && this.#extracted_rounds.get(thread_id) === round_id) {
      return; // 同 round 幂等（resume/重放不重复抽取）
    }
    let ledger: JsonRecord | null = null;
    try {
      const facts = this.#facts(ctx);
      if (facts !== null && facts !== undefined) {
        ledger = isRecord(facts) ? (facts as JsonRecord) : null;
      }
    } catch {
      ledger = null;
    }
    if (ledger === null) return;
    const entries = extract_entries_from_ledger(ledger, {
      namespace: this.#namespace,
      priority_confirmation: this.#priority_confirmation,
      priority_intent: this.#priority_intent,
      priority_conclusion: this.#priority_conclusion,
    });
    if (round_id !== '') this.#extracted_rounds.set(thread_id, round_id);
    if (entries.length === 0) return;
    try {
      await arbitrate_and_store(this.#store, entries);
    } catch {
      // 记忆存储失败只跳过（观测侧；冲突消解异常不阻断 run 交付）
    }
  }
}
