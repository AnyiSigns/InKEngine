/**
 * llm 内核 config 化字段 I/O 的共用约定（llm_decider/router_judge 共用）。
 *
 * 实例可经 config 分化自身的数据通道读写面，全部向后兼容（缺省 = 现状行为）：
 *
 * - `output_field?: string`：本轮回复写入的状态通道键。缺省/空值 = 写既有
 *   `reply`（STATE_REPLY）；显式非空键 = 该键写入并作为本实例的产出声明面。
 *   内部保留键（`_` 前缀 = 引擎内部/其他内核通道，如 `_route_to`、
 *   `_thread_skeleton`、`_round_continuation`、`_round_graph`、`_recent_tops`）
 *   与结构性节点通道键（messages/pending/tool_rounds/display_*）一律拒绝
 *   （写护栏：防 llm 实例覆写内部状态通道破坏运行不变量）。
 * - `read_fields?: string[]`：把状态通道中这些键的既有内容只读投影进本轮
 *   提示上下文（供字段链下游消费前序结点产出）。缺省 = 只读消息链/回合输入
 *   （现状）。投影为提示侧文本段拼接（user 消息追加），不写入持久化消息链，
 *   不污染消息链语义——投影内容本身已随状态通道字段持久化，链上重放即得。
 *
 * 本模块只做 config 归一/护栏/文本投影（纯函数），不含执行逻辑。
 */

import { GraphDefinitionError } from '../errors.js';
import {
  STATE_DISPLAY_MESSAGES,
  STATE_DISPLAY_SEQ,
  STATE_MESSAGES,
  STATE_PENDING,
  STATE_REPLY,
  STATE_TOOL_ROUNDS,
} from './constants.js';

/** config 键名（装配/实例数据的协议面，不可改名）。 */
export const CFG_OUTPUT_FIELD = 'output_field';
export const CFG_READ_FIELDS = 'read_fields';

/** llm 回复落点的结构性通道保留键（写入即拒绝；`_` 前缀内部键另行按前缀拒绝）。 */
export const LLM_OUTPUT_RESERVED_KEYS: readonly string[] = [
  STATE_MESSAGES,
  STATE_PENDING,
  STATE_TOOL_ROUNDS,
  STATE_DISPLAY_MESSAGES,
  STATE_DISPLAY_SEQ,
];

/** 保留键判定：`_` 前缀（引擎内部/其他内核通道）或结构性通道键 = 拒绝写入。 */
export function is_reserved_output_key(key: string): boolean {
  if (key === '') return false;
  if (key.startsWith('_')) return true;
  return (LLM_OUTPUT_RESERVED_KEYS as readonly string[]).includes(key);
}

/** config.output_field 归一：未配置/非法形态 = ''；命中保留键 = 抛错拒绝。 */
export function parse_output_field_key(config: Record<string, unknown>): string {
  const raw = config[CFG_OUTPUT_FIELD];
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return '';
  const key = raw.trim();
  if (key === '') return '';
  if (is_reserved_output_key(key)) {
    throw new GraphDefinitionError(`config.output_field 写入保留状态键被拒绝: '${key}'`);
  }
  return key;
}

/** llm 内核实际回复落点（缺省 = 现有 reply 键；空/未配置 = reply）。 */
export function llm_output_key(config: Record<string, unknown>): string {
  const key = parse_output_field_key(config);
  return key === '' ? STATE_REPLY : key;
}

/** config.read_fields 归一：字符串键按序去重去空；非字符串条目忽略。 */
export function config_read_fields(config: Record<string, unknown>): string[] {
  const raw = config[CFG_READ_FIELDS];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 单值文本投影（字符串原样；结构化值 JSON 化；空值不投影）。 */
function _project_text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return String(value);
}

/**
 * 把 read_fields 命中的既有状态内容拼成一段只读提示文本（无命中 = null）。
 * 形态 = 文本段拼接（user 消息追加），不改写状态、不进入持久化消息链。
 */
export function build_read_projection(
  state: Record<string, unknown>,
  read_fields: readonly string[],
): string | null {
  if (read_fields.length === 0) return null;
  const lines: string[] = ['以下为状态通道既有内容（只读投影，仅作本轮参考，无需复述）：'];
  for (const key of read_fields) {
    const text = _project_text(state[key]);
    if (text === null) continue;
    lines.push(`[${key}]`);
    lines.push(text);
  }
  return lines.length === 1 ? null : lines.join('\n');
}
