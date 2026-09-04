/**
 * 孵化事件发射（growth.py 事件侧私有方法面移植）。
 *
 * 事件面 = 前端演化页签的实时数据面：signal_detected / distill_outcome /
 * gate_verdict 三事件按信号 id 关联（前端时间线合并为一条）；注入 emit
 * 回调 = 转发引擎事件流，未注入 = 静默，不影响沉淀链路。发射失败一律吞
 * 异常（观测不阻断沉淀——Python 记 warning，TS core 零 IO 不落）。
 *
 * TS seam 差异：Python 的事件发射是 GrowthPipeline 实例方法，本模块抽为
 * 模块级函数（发射所需状态只有 emit 回调与信号本身）；_signal_id 在 Python
 * 用 abs(hash((kind, message))) % 10**8，而 Python hash() 对字符串是进程
 * 随机种子、跨进程不稳定——TS 以确定性 FNV-1a 指纹替代（同一信号同 id 的
 * 关联语义保持，且跨进程可复现）。uuid 只出现在落位条目，事件侧一律用
 * 指纹（signal_id），故此处无 uuid seam。
 */

import type { JsonRecord } from '../json.js';
import type { ExecutionSignal } from '../knowledge_signals/signals.js';

/** 孵化事件发射回调（(etype, payload) -> Promise；镜像 Python Callable）。 */
export type GrowthEmit = (etype: string, payload: JsonRecord) => Promise<void>;

/**
 * 信号稳定指纹（同因聚合后仍可关联：kind+message 摘要指纹）。
 *
 * Python 侧为 abs(hash((kind, message))) % 10**8——hash 跨进程不稳定，TS
 * 以确定性 FNV-1a（32 位）替代：非负、同输入同输出、跨进程可复现。
 */
export function signal_fingerprint(kind: string, message: string): number {
  const text = `${kind}\u0000${message}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100000000;
}

/** 信号 id 形态：sig:<kind>:<指纹>（信号检测 → 蒸馏 → 闸门三事件共用）。 */
export function signal_id(kind: string, message: string): string {
  return `sig:${kind}:${signal_fingerprint(kind, message)}`;
}

/** 发射孵化事件（注入回调转发；异常忽略——观测不阻断沉淀）。 */
export async function publish_emit(
  emit: GrowthEmit | null | undefined,
  etype: string,
  payload: JsonRecord,
): Promise<void> {
  if (emit === null || emit === undefined) return;
  try {
    await emit(etype, payload);
  } catch {
    // 孵化事件发射失败只跳过（Python 记 warning；TS core 零 IO 不落）
  }
}

/** 信号检测事件（signal_id = 蒸馏/闸门事件关联锚）。 */
export async function emit_signal_detected(
  emit: GrowthEmit | null | undefined,
  signal: ExecutionSignal,
): Promise<void> {
  await publish_emit(emit, 'signal_detected', {
    signal_id: signal_id(signal.kind, signal.message),
    signal_type: signal.kind,
    signal: signal.message,
    source: signal.source,
  });
}

/** 蒸馏产物事件（关联到触发蒸馏的信号）。 */
export async function emit_distill_outcome(
  emit: GrowthEmit | null | undefined,
  signal: ExecutionSignal,
  data: JsonRecord | null,
): Promise<void> {
  let distilled = '';
  if (data !== null) {
    const rawInsight = data['insight'];
    const insight =
      rawInsight !== null &&
      rawInsight !== undefined &&
      typeof rawInsight === 'object' &&
      !Array.isArray(rawInsight)
        ? (rawInsight as Record<string, unknown>)
        : {};
    const message = insight['message'];
    if (typeof message === 'string') distilled = message;
  }
  await publish_emit(emit, 'distill_outcome', {
    signal_id: signal_id(signal.kind, signal.message),
    distilled: distilled !== '' ? distilled : '蒸馏产物（确定性基线）',
  });
}

/** 闸门判定事件参数（放行/拦截两态共用）。 */
export interface GateVerdictPayload {
  passed: boolean;
  level: string;
  reason: string;
}

/** 闸门判定事件（放行/拦截都发——前端时间线两态可见）。 */
export async function emit_gate_verdict(
  emit: GrowthEmit | null | undefined,
  signal: ExecutionSignal,
  verdict: GateVerdictPayload,
): Promise<void> {
  await publish_emit(emit, 'gate_verdict', {
    signal_id: signal_id(signal.kind, signal.message),
    passed: verdict.passed,
    level: verdict.level,
    reason:
      verdict.reason ||
      (verdict.passed ? '已放行' : '未通过闸门'),
  });
}
