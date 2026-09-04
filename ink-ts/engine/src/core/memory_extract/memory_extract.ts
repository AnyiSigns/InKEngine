/**
 * 记忆无感提取 + 冲突消解。
 *
 * 蒸馏链显式信号之外，回合账本事件流中用户意图 / 结论要点自动提取入记忆
 * （规则抽取优先——用户指令 / 最终回复 / 确认，零 LLM）；冲突消解 = 同
 * namespace + kind 条目按可信度 / 时间序仲裁（新旧并存留痕，不静默覆盖）。
 *
 * 记忆口径 = 「用户级长程共享」：回合账本来自任一会话（thread），但抽取
 * 落位统一到用户级命名空间（DEFAULT_NAMESPACE = "user:default"），不带
 * thread 维度——多线程的回合事实在同一用户命名空间下积累、经 memory.list
 * 整面可取可管理（条目 meta 保留 ledger_round 溯源）。
 *
 * 逻辑全在 engine core 内（不新增宿主模块），复用 StorageBackedMemoryStore
 * 同一记忆接口；语义归并（可选弱模型档）留作扩展点，本模块默认零 LLM
 * 规则抽取。
 */

import { isRecord, type JsonRecord } from '../json.js';
import { MemoryEntry } from '../memory/memory.js';
import type { StorageBackedMemoryStore } from '../memory/store.js';

// ── 回合事实提取规则（权威口径，防跨侧漂移）──
//
// 单一事实来源：壳侧回合账本归约（round_ledger.rs RECOGNIZED_EVENTS）
// 与引擎信号分类（SignalClassifier.classify）都引用本集合——
// 「哪些事件构成回合事实要点」的口径统一由本模块定义，壳侧/Rust 侧
// 不得自建一套事件清单（契约守卫：test/core/memory_extract 断言集合形态，
// 壳侧有同口径常量经桥 op 导出校验）。

// 账本事实事件全集：回合事件流中值得沉淀为「事实快照」的类型
// （壳侧账本归约保留集 + 确认类）——memory_extract 从账本 events 里
// 按本集合找确认事件；壳侧 reduce_round 保留本集合内的事件进账本。
export const ROUND_FACT_EVENTS: readonly string[] = [
  // 执行轨迹事实（账本归约保留的步骤要点）
  'tool_start',
  'tool_end',
  'plan_start',
  'spawn_start',
  'error',
  'node_error',
  'tool_error',
  'validation_error',
  // 确认类事实（用户显式确认 = 最强记忆来源）
  'accept',
  'edit',
  'reject',
  'user_correction',
  'user_confirm',
];

// 确认类事件类型（规则抽取触发点）——真实引擎事件类型（审批卡决议
// accept/reject、修正 edit/user_correction、洞见确认 user_confirm）；
// 历史虚构类型（confirmation/approval_accept）已移除，防永远抽不到。
export const CONFIRMATION_EVENTS: readonly string[] = [
  'accept',
  'edit',
  'reject',
  'user_correction',
  'user_confirm',
];

// 默认记忆域 = 用户级长程共享命名空间（跨线程回合事实统一落此域；
// 无 thread_id 维度——thread 语义由回合账本承载，记忆本身用户级共享）。
export const DEFAULT_NAMESPACE = 'user:default';

// 抽取条目的优先级档（数据化，ENG1-13：旧实现硬编码 6/5/7 魔法数字）。
// 语义：确认类（用户显式确认 = 最强事实）> 意图（回合指令）> 结论
// （模型产出要点）。宿主可按产品语义覆盖。
export const PRIORITY_CONFIRMATION = 7;
export const PRIORITY_INTENT = 6;
export const PRIORITY_CONCLUSION = 5;

/** extract_entries_from_ledger 的命名选项（Python kw-only 参数的 TS 映射）。 */
export interface ExtractLedgerOptions {
  namespace?: string;
  priority_confirmation?: number;
  priority_intent?: number;
  priority_conclusion?: number;
}

/** 宽松取键：等价 Python dict.get（缺失键按 undefined 处理）。 */
function get(record: JsonRecord, key: string): unknown {
  return key in record ? (record[key] as unknown) : undefined;
}

/** Python 真值口径：None/False/0/''/空容器一律为假。 */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Python `a or b or c` 链：取首个真值（全假回落 undefined）。 */
function firstTruthy(...values: unknown[]): unknown {
  for (const value of values) if (isTruthy(value)) return value;
  return undefined;
}

/** 对齐 json.dumps(detail, ensure_ascii=False) 的确定性序列化（保留键插入序）。 */
function jsonDumps(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map(jsonDumps).join(', ')}]`;
  }
  const record = value as JsonRecord;
  const parts: string[] = [];
  for (const key of Object.keys(record)) {
    parts.push(`${JSON.stringify(key)}: ${jsonDumps(record[key] as unknown)}`);
  }
  return `{${parts.join(', ')}}`;
}

/**
 * 从回合账本规则抽取记忆条目（零 LLM）。
 *
 * 抽取点：意图（intent）、结论（conclusion）、确认类事件（approval /
 * confirm）。每条带 ledger_round 溯源，便于回溯与去重仲裁。优先级档
 * 为数据化参数（缺省 = 模块常量），宿主可覆盖。
 */
export function extract_entries_from_ledger(
  ledger: JsonRecord,
  options: ExtractLedgerOptions = {},
): MemoryEntry[] {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const priority_confirmation = options.priority_confirmation ?? PRIORITY_CONFIRMATION;
  const priority_intent = options.priority_intent ?? PRIORITY_INTENT;
  const priority_conclusion = options.priority_conclusion ?? PRIORITY_CONCLUSION;
  const out: MemoryEntry[] = [];
  const meta_base: Record<string, unknown> = {
    ledger_round: get(ledger, 'round_id') ?? null,
    source: 'round_ledger',
  };

  const intent = get(ledger, 'intent');
  if (isTruthy(intent)) {
    out.push(
      new MemoryEntry({
        namespace,
        kind: 'intent',
        content: String(intent),
        source: 'round_ledger',
        priority: priority_intent,
        meta: { ...meta_base },
      }),
    );
  }

  const conclusion = get(ledger, 'conclusion');
  if (isTruthy(conclusion)) {
    out.push(
      new MemoryEntry({
        namespace,
        kind: 'conclusion',
        content: String(conclusion),
        source: 'round_ledger',
        priority: priority_conclusion,
        meta: { ...meta_base },
      }),
    );
  }

  const rawEvents = get(ledger, 'events');
  const events: unknown[] = Array.isArray(rawEvents) ? rawEvents : [];
  for (const raw of events) {
    const ev: JsonRecord = isRecord(raw) ? raw : {};
    const kindRaw = firstTruthy(get(ev, 'kind'), get(ev, 'type'));
    const kind = kindRaw === undefined ? '' : String(kindRaw);
    if (!CONFIRMATION_EVENTS.includes(kind)) continue;
    const detailRaw = firstTruthy(get(ev, 'detail'), get(ev, 'payload'));
    const detail: JsonRecord = isRecord(detailRaw) ? detailRaw : {};
    const contentRaw = firstTruthy(get(detail, 'content'), get(detail, 'message'));
    const content = contentRaw === undefined ? jsonDumps(detail) : String(contentRaw);
    out.push(
      new MemoryEntry({
        namespace,
        kind: 'confirmation',
        content,
        source: 'round_ledger',
        priority: priority_confirmation,
        meta: { ...meta_base },
      }),
    );
  }

  return out;
}

/** 内容归一（去空白），用于冲突判定（同源重写视为同一条）。 */
function _normalize(content: string): string {
  return content.trim().split(/\s+/).join(' ');
}

/** 冲突判定：同 namespace + kind 且内容不同（归一后）→ 冲突。
 *  内容相同视为重复抽取，不视为冲突（去重处理）。 */
function _conflicts(old: MemoryEntry, newEntry: MemoryEntry): boolean {
  return _normalize(old.content) !== _normalize(newEntry.content);
}

/** 仲裁留痕记录（Python arbitrations 列表中元素形态）。 */
export interface MemoryExtractArbitration {
  action: 'coexist';
  new_id: string;
  old_id: string;
  new_priority: number;
  old_priority: number;
}

/** arbitrate_and_store 结果（Python 返回 dict 的 TS 定型）。 */
export interface ArbitrateStoreResult {
  stored: string[];
  arbitrations: MemoryExtractArbitration[];
  skipped: string[];
}

/**
 * 仲裁并存储抽取条目（异步，由调用方 await）。
 *
 * 仲裁规则：同 namespace + kind 且内容冲突 → 新旧并存留痕（不静默覆盖）：
 * 旧条目不删，新条目以可信度（priority）落位，双方互写 arbitration 溯源
 * （coexist:<id>）；内容相同（重复抽取）→ 跳过存储（去重）。
 * 返回 {stored, arbitrations, skipped}。
 */
export async function arbitrate_and_store(
  store: StorageBackedMemoryStore,
  entries: readonly MemoryEntry[],
): Promise<ArbitrateStoreResult> {
  const stored: string[] = [];
  const arbitrations: MemoryExtractArbitration[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const existing = await store.query({
      namespace: entry.namespace,
      kind: entry.kind,
    });
    // 内容相同 → 去重跳过
    let deduped = false;
    for (const old of existing) {
      if (_normalize(old.content) === _normalize(entry.content)) {
        skipped.push(old.id ?? '');
        deduped = true;
        break;
      }
    }
    if (deduped) continue;
    // 无相同内容：检查冲突（不同内容同 namespace+kind）
    let conflict_old: MemoryEntry | null = null;
    for (const old of existing) {
      if (_conflicts(old, entry)) {
        conflict_old = old;
        break;
      }
    }
    const entry_id = await store.save(entry);
    stored.push(entry_id);
    if (conflict_old !== null && conflict_old.id !== null) {
      // 新旧并存留痕（不静默覆盖）
      await store.update(conflict_old.id, {
        meta: {
          ...conflict_old.meta,
          arbitration: `coexist:${entry_id}`,
        },
      });
      await store.update(entry_id, {
        meta: {
          ...entry.meta,
          arbitration: `coexist:${conflict_old.id}`,
        },
      });
      arbitrations.push({
        action: 'coexist',
        new_id: entry_id,
        old_id: conflict_old.id,
        new_priority: entry.priority,
        old_priority: conflict_old.priority,
      });
    }
  }
  return { stored, arbitrations, skipped };
}