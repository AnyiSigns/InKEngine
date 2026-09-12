/**
 * 回合账本合并（按需 LLM 的便宜档回落为确定性归约，复用引擎既有压缩形态）。
 *
 * 回合账本 = 压缩前的事实快照；合并复用消息压缩的「摘要替换」形态：产物是
 * 同构摘要 JSON（summary 即压缩后链首消息），可被同一召回/续跑形态复用。
 * 确定性路径零模型：拼装文本逐行抽取、去空行，累计超限即截断并落标记；
 * LLM 路径把同一份拼装文本交给注入的便宜档摘要钩子，两条路径产出一致骨架。
 * generated_at 属时间副作用，由宿主经 now 钩子注入（等价 Python time.time）；
 * 未注入时按确定值 0 落盘，保证纯函数可复现。
 */

import { isRecord, type JsonRecord } from '../json.js';

export const SUMMARY_SCHEMA = 'round_ledger_summary/1';

/** 确定性压缩文本上限（超过截断，保留关键行）。 */
const COMPRESS_LIMIT = 2000;

/** 单本账本：事实快照（宽松取键，缺省字段按 Python dict.get 口径处理）。 */
export type Ledger = JsonRecord;

/** 合并产物：与消息压缩摘要同构的链首形态。 */
export interface LedgerSummary {
  schema: string;
  generated_at: number;
  summary: string;
  source_count: number;
}

/** merge_ledger 的可选注入面：便宜档摘要钩子与时间源 seam。 */
export interface MergeLedgerOptions {
  /** 便宜档摘要函数（文本 -> 摘要）；未提供走确定性压缩。 */
  llm_summarize?: (text: string) => string;
  /** 时间源（宿主注入，等价 Python 的 time.time）；缺省按 0 保证确定性。 */
  now?: () => number;
}

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

/** Python str() 口径的标量渲染（None 兜底、布尔大写）。 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return jsonDumps(value);
}

/** 对齐 json.dumps(detail, ensure_ascii=False) 的确定性序列化：保留键插入序与分隔空格。 */
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

/** 单账本 → 可压缩文本（意图/结论/事件要点/既有摘要）。 */
function ledgerText(ledger: JsonRecord): string {
  const parts: string[] = [];
  const intent = get(ledger, 'intent');
  if (isTruthy(intent)) parts.push(`意图: ${pyStr(intent)}`);
  const conclusion = get(ledger, 'conclusion');
  if (isTruthy(conclusion)) parts.push(`结论: ${pyStr(conclusion)}`);
  const rawEvents = get(ledger, 'events');
  const events: unknown[] = Array.isArray(rawEvents) ? rawEvents : [];
  for (const raw of events) {
    const ev: JsonRecord = isRecord(raw) ? raw : {};
    const kindRaw = get(ev, 'kind');
    const kind: unknown = isTruthy(kindRaw)
      ? kindRaw
      : isTruthy(get(ev, 'type'))
        ? get(ev, 'type')
        : 'event';
    let detail: unknown = isTruthy(get(ev, 'detail'))
      ? get(ev, 'detail')
      : isTruthy(get(ev, 'payload'))
        ? get(ev, 'payload')
        : {};
    if (isRecord(detail)) detail = jsonDumps(detail);
    parts.push(`- ${pyStr(kind)}: ${pyStr(detail)}`);
  }
  const summary = get(ledger, 'summary');
  if (isTruthy(summary)) parts.push(`既有摘要: ${pyStr(summary)}`);
  return parts.join('\n');
}

/** 确定性抽取压缩（零模型）：逐行 strip、去空行，累计超限即截断并落标记。 */
function deterministicCompress(text: string, limit: number = COMPRESS_LIMIT): string {
  const kept: string[] = [];
  let total = 0;
  for (const rawLine of text.split(/[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (total + line.length + 1 > limit) {
      kept.push('…(截断)');
      break;
    }
    kept.push(line);
    total += line.length + 1;
  }
  return kept.join('\n');
}

/**
 * 合并旧摘要 + 新账本为一次增量摘要。
 *
 * 旧摘要作为首段「[旧摘要]」前缀计入拼装文本（None/空串 = 首次合并）；
 * 每个新账本经 ledgerText 抽取为要点段落，段落间空行分隔。摘要钩子注入时
 * 直接把拼装文本交给钩子，否则走 deterministicCompress 截断保底。
 *
 * @returns {schema, generated_at, summary, source_count}——summary 与
 *   build_message_compress_patches 的链首摘要同构，可被续跑上下文复用。
 */
export function merge_ledger(
  old_summary: string | null,
  new_ledgers: readonly Ledger[] | null | undefined,
  options: MergeLedgerOptions = {},
): LedgerSummary {
  const { llm_summarize, now } = options;
  const combined: string[] = [];
  if (old_summary) combined.push(`[旧摘要]\n${old_summary}`);
  const ledgers = new_ledgers ?? [];
  for (const raw of ledgers) combined.push(ledgerText(isRecord(raw) ? raw : {}));
  const text = combined.join('\n\n');
  const summary = llm_summarize ? llm_summarize(text) : deterministicCompress(text);
  return {
    schema: SUMMARY_SCHEMA,
    generated_at: now ? now() : 0,
    summary,
    source_count: ledgers.length + (old_summary ? 1 : 0),
  };
}
