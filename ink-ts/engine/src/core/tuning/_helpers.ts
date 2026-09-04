/**
 * 调参器私有辅助（tuning.py 模块私有函数/格式器段移植）。
 *
 * _params_entry：调参产物 → 知识条目（kind=weight，参数回归的评估对象
 * 形态）；_fmt2/_fmt1：变更说明/note 中 Python `:.2f`/`:.1f` 的可读呈现。
 * 本文件为 tuning 域私有（index 不 re-export）。
 */

import {
  KIND_WEIGHT,
  LEVEL_WORK,
  SOURCE_MODEL,
  KnowledgeEntry,
} from '../knowledge_set/index.js';
import { _DEFAULT_NOW } from './_constants.js';
import type { TunableParams } from './_params.js';

/** Python `:.2f` 小数格式（变更说明/note 的可读呈现）。 */
export function _fmt2(value: number): string {
  return value.toFixed(2);
}

/** Python `:.1f` 小数格式（收敛轮数均值呈现）。 */
export function _fmt1(value: number): string {
  return value.toFixed(1);
}

/** 调参产物 → 知识条目（kind=weight：参数回归的评估对象形态）。 */
export function _params_entry(params: TunableParams): KnowledgeEntry {
  return new KnowledgeEntry({
    id: `tune-${Math.trunc(_DEFAULT_NOW() * 1000)}`,
    level: LEVEL_WORK,
    kind: KIND_WEIGHT,
    data: params.to_dict(),
    source: SOURCE_MODEL,
    credibility: 1.0,
    title: '调参回归样本',
  });
}
