/**
 * 实体演化域工具 + 演化事件负载构建（entity_evolution.py 私有模块函数面
 * 移植：教训指纹 / 事件来源派生 / 信号稳定 id / 演化动态事件负载）。
 *
 * 指纹与 id 的确定性 seam：Python 侧 sha1/hash() 的随机进程种子在本重表达
 * 中替换为纯 TS 确定性实现——教训指纹取 sha256（_sha256.ts，与 builder 域
 * 同源纯实现）12 hex 前缀；信号 id 取 FNV-1a 32 位稳定哈希（`% 1e8` 与
 * Python 对齐）。时间 seam now=0（纯逻辑不进 Date.now）。
 */

import { sha256_hex } from '../builder/_sha256.js';
import type { EntitySpec } from '../entities/entities.js';
import type { EngineEvent } from '../events/events.js';
import { SOURCE_MODEL, SOURCE_RANK, SOURCE_USER } from '../knowledge_signals/_types.js';
import type { ExecutionSignal } from '../knowledge_signals/signals.js';
import { LEVEL_WORK } from '../knowledge_set/index.js';

/** 时间 seam（确定性：纯逻辑不进 Date.now，now=0 可复现）。 */
export function _now(): number {
  return 0;
}

/** 字典判定/规约（镜像 dict(x or {})：非 dict 形态按空 dict 兜底）。 */
export function as_dict(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** 列表规约（镜像 list(x or [])：非列表形态按空列表兜底）。 */
export function as_list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Python int() 口径数值规约（数值截断；NaN/缺失按 0——meta 内为整数）。 */
export function to_int(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** FNV-1a 32 位纯字符串哈希（确定性信号 id 种子；core 零 node:crypto）。 */
function _fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 教训指纹（同因去重锚：归一化消息摘要，跨呈现形态稳定）。
 *  Python 侧 sha1[:12]；TS 侧 sha256[:12]（确定性纯实现，语义等价）。 */
export function _lesson_fingerprint(message: string): string {
  const normalized = String(message)
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .join(' ');
  return sha256_hex(new TextEncoder().encode(normalized)).slice(0, 12);
}

/** 信号稳定 id（同因聚合后仍可关联：kind+实体+消息摘要指纹）。 */
export function _signal_id(signal: ExecutionSignal): string {
  const raw = signal.context['entity_id'];
  const entity_id = typeof raw === 'string' && raw ? raw : '-';
  const digest = _fnv1a(`${signal.kind}\u0000${entity_id}\u0000${signal.message}`);
  return `sig:${signal.kind}:${entity_id}:${digest % 100000000}`;
}

/** 事件来源派生（评审决议类事件 = 用户来源；其余取负载声明）。 */
export function _source_from_event(event: EngineEvent): string {
  const payload = event.payload ?? {};
  const source = payload['source'];
  if (typeof source === 'string' && source in SOURCE_RANK) {
    return source;
  }
  if (['accept', 'edit', 'reject', 'user_correction'].includes(event.type)) {
    return SOURCE_USER;
  }
  return SOURCE_MODEL;
}

// ── 演化事件负载构建（前端演化页签实时数据面；Python 管线私有方法内联
// 段抽出，保持 pipeline.ts 单文件可控；发射语义仍在管线 _publish 统一）──

/** 实体演化读出的 level 字段规约（字符串缺省/空值回落工作级）。 */
export function _evolution_level(value: unknown): string {
  return typeof value === 'string' && value ? value : LEVEL_WORK;
}

/** signal_detected 负载（signal_id 稳定关联同因聚合）。 */
export function signal_detected_payload(signal: ExecutionSignal): Record<string, unknown> {
  const raw = signal.context['entity_id'];
  return {
    signal_id: _signal_id(signal),
    signal_type: signal.kind,
    signal: signal.message,
    source: signal.source,
    entity_id: typeof raw === 'string' ? raw : undefined,
  };
}

/** distill_outcome 负载（确定性基线变异产物 = 教训块文本）。 */
export function distill_outcome_payload(
  signal: ExecutionSignal,
  lesson_text: string,
): Record<string, unknown> {
  return {
    signal_id: _signal_id(signal),
    distilled: lesson_text || '变异产物（确定性基线）',
  };
}

/** gate_verdict 负载（reason 兜底按 passed 给可读文案）。 */
export function gate_verdict_payload(
  signal: ExecutionSignal,
  passed: boolean,
  reason: string,
): Record<string, unknown> {
  return {
    signal_id: _signal_id(signal),
    passed,
    level: 'L1/L2/L3',
    reason: reason || (passed ? '已放行' : '未通过闸门'),
  };
}

/** entity_mutated 负载（version/level/coverage 取自进化 meta 留痕）。 */
export function entity_mutated_payload(spec: EntitySpec): Record<string, unknown> {
  const evolved = as_dict(spec.meta['evolution']);
  return {
    entity_id: spec.id,
    version: to_int(evolved['version']),
    level: _evolution_level(evolved['level']),
    coverage: to_int(evolved['addressed_count']),
  };
}

/** entity_promoted 负载（from_level → to_level 层级跃迁面）。 */
export function entity_promoted_payload(
  spec: EntitySpec,
  from_level: string,
): Record<string, unknown> {
  const evolved = as_dict(spec.meta['evolution']);
  return {
    entity_id: spec.id,
    from_level,
    to_level: _evolution_level(evolved['level']),
  };
}
