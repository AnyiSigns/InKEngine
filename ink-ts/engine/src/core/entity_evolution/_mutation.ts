/**
 * 确定性变异蒸馏（pipeline._derive_mutation 段抽出，保持单文件 ≤350 行）：
 * 失败信号 → 变异声明。零 LLM 纯函数：失败信号消息摘要追加进 persona 的
 * 「已知教训」块——教训指纹去重（同因重复不追加，防 persona 无界膨胀）；
 * 教训文本截断有界，条数上限可配。无可沉淀教训 = null（不变异）。
 */

import { EntitySpec } from '../entities/entities.js';
import type { ExecutionSignal } from '../knowledge_signals/signals.js';
import { _LESSON_CHAR_LIMIT, _MAX_PERSONA_LESSONS, EntityMutationResult } from './_types.js';
import {
  _evolution_level,
  _lesson_fingerprint,
  _now,
  as_dict,
  as_list,
  to_int,
} from './_util.js';

/** 失败信号 → 变异声明（教训指纹去重；无可沉淀 = null）。 */
export function _derive_mutation(
  spec: EntitySpec,
  signals: readonly ExecutionSignal[],
): EntityMutationResult | null {
  const evolved = as_dict(spec.meta['evolution']);
  const existing = new Set<string>();
  for (const item of as_list(evolved['lessons'])) {
    const fp = as_dict(item)['fingerprint'];
    if (typeof fp === 'string' && fp) existing.add(fp);
  }
  if (existing.size >= _MAX_PERSONA_LESSONS) return null;
  const added: Array<[string, string]> = [];
  for (const signal of signals) {
    const text = String(signal.message ?? '').trim();
    if (!text) continue;
    const fingerprint = _lesson_fingerprint(text);
    if (existing.has(fingerprint)) continue;
    if (added.some(([fp]) => fp === fingerprint)) continue;
    added.push([fingerprint, text.slice(0, _LESSON_CHAR_LIMIT)]);
  }
  if (added.length === 0) return null;
  const lessonItems = as_list(evolved['lessons']).map((item) => ({
    ...as_dict(item),
  }));
  for (const [fingerprint, text] of added) {
    lessonItems.push({ fingerprint, text });
  }
  const lessonBlock = lessonItems
    .map((item) => `- ${String(item['text'] ?? '')}`)
    .join('\n');
  const persona = spec.persona
    ? `${spec.persona}\n\n已知教训：\n${lessonBlock}`
    : `已知教训：\n${lessonBlock}`;
  const newMeta = { ...spec.meta };
  newMeta['evolution'] = {
    version: to_int(evolved['version']) + 1,
    level: _evolution_level(evolved['level']),
    lessons: lessonItems,
    addressed_count: to_int(evolved['addressed_count']) + added.length,
    mutations: to_int(evolved['mutations']) + 1,
    last_mutation_at: _now(),
  };
  const mutated = new EntitySpec({
    id: spec.id,
    label: spec.label,
    persona,
    model: spec.model,
    meta: newMeta,
  });
  return new EntityMutationResult({ spec: mutated, new_lessons: added.length });
}
