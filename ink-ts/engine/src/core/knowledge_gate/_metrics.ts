/**
 * L3 缺省维度指标派生（knowledge_gate.py L2 耗时归一化基准 + _default_l3_metrics
 * 段移植）。
 *
 * 未注入 new_metrics 时的兜底口径：规则类条目 accuracy = L2 样例通过率
 * （效果的真实度量）；insight 教训条目无规则执行语义（L2 跳过执行，accuracy
 * 恒 0.0 是「未测量」而非「劣」）——缺省派生不含 accuracy，避免与母体派生
 * 指标比较时产生虚假的「劣于旧版」误判，只留 latency/safety 中性维度（与
 * 旧版可比且不产生虚假优劣）。latency = 1 - min(latency_ms / 基准, 1)。
 */

import { KIND_INSIGHT } from '../knowledge_set/_types.js';
import type { KnowledgeEntry } from '../knowledge_set/knowledge_entry.js';
import type { GateL2Result } from './_results.js';

/** L2 耗时 → L3 latency 维度的归一化基准（10000ms = 满分基线，超出
 *  线性衰减到 0；硬编码魔法数字提为常量）。 */
export const LATENCY_NORM_MS = 10000.0;

/** L3 缺省维度指标派生（未注入 new_metrics 时的兜底口径）。 */
export function _default_l3_metrics(
  entry: KnowledgeEntry,
  l2: GateL2Result,
): Record<string, number> {
  const latency = 1.0 - Math.min(l2.latency_ms / LATENCY_NORM_MS, 1.0);
  const metrics: Record<string, number> = { latency: latency, safety: l2.safety_score };
  if (entry.kind !== KIND_INSIGHT) {
    metrics['accuracy'] = l2.accuracy;
  }
  return metrics;
}
