/**
 * 技能结晶纯机制（skill_crystal.py 分类/命名/命中率/报告函数移植）：
 *
 * - classify_skill_kind：技能分类（路径首结点消费 image 字段或结点类型含
 *   视觉语义 = 视觉技能，否则通用路径技能）——判定纯算法、零 LLM；
 * - _skill_name：确定性技能名（分类 + 域 + 指纹前缀，同名重结晶版本递增）；
 * - _success_rate：命中率（命中/(命中+失败)，无样本 = 0）；
 * - build_test_report：测试报告（随技能导出分享；样本边 = 证据快照按净
 *   成功降序取前五，报告不携带任何运行时状态，纯派生事实）。
 *
 * 本文件函数均为模块私有/纯函数：跨文件消费方经显式导入使用（单点实现，
 * 不落 index 重导出）。
 */

import { isRecord } from '../json.js';
import {
  SKILL_KIND_PATH,
  SKILL_KIND_VISUAL,
} from './_types.js';

/** Python round 的 TS 实现（缩放 10^digits 后四舍五入；半分位遵循 JS
 *  half-up，与 Python 银行家舍入在极少 tie 情形有差——数据驱动的成功率
 *  网格远离半分位，回归一致）。 */
export function _round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 命中率（无样本 = 0；与 Python _success_rate 同判据）。 */
export function _success_rate(hit_count: number, fail_count: number): number {
  const total = hit_count + fail_count;
  return total > 0 ? hit_count / total : 0.0;
}

/**
 * 技能分类：路径首结点消费 image 字段（或结点类型含视觉语义）=
 * 视觉技能，否则通用路径技能。
 *
 * 判定纯算法、零 LLM：遍历路径结点契约的输入字段名与结点类型名
 * （大小写不敏感），命中 image/视觉语义即判视觉——感知结点
 * image→描述链路的结晶标签来源。
 */
export function classify_skill_kind(path: unknown): string {
  if (!isRecord(path)) return SKILL_KIND_PATH;
  const nodes = path['nodes'];
  if (!isRecord(nodes)) return SKILL_KIND_PATH;
  const visualTypeTokens = [
    'vision',
    'perceive',
    'image',
    'ocr',
    'describe',
    'screenshot',
  ];
  for (const spec of Object.values(nodes)) {
    if (!isRecord(spec)) continue;
    const typeName = String(spec['type'] ?? '').toLowerCase();
    if (visualTypeTokens.some((token) => typeName.includes(token))) {
      return SKILL_KIND_VISUAL;
    }
    const contract = isRecord(spec['contract']) ? spec['contract'] : {};
    const rawInputSchema = isRecord(spec['input_schema'])
      ? spec['input_schema']
      : null;
    const inputSchema =
      rawInputSchema ??
      (isRecord(contract['input_schema']) ? contract['input_schema'] : {});
    const fields = Array.isArray(inputSchema['fields'])
      ? inputSchema['fields']
      : [];
    for (const field of fields) {
      if (!isRecord(field)) continue;
      const name = String(field['name'] ?? '').toLowerCase();
      if (name.includes('image') || name === 'screenshot' || name === 'picture' || name === 'snapshot') {
        return SKILL_KIND_VISUAL;
      }
    }
  }
  return SKILL_KIND_PATH;
}

/** 技能名（确定性：分类 + 域 + 指纹前缀；同名重结晶版本递增）。 */
export function _skill_name(fingerprint: string, domain: string, kind: string): string {
  return `${kind}.${domain}.${fingerprint.slice(0, 12)}`;
}

/**
 * 测试报告（随技能导出分享；含命中率/样本边/生成时间）。
 *
 * 样本边 = 证据快照按净成功（success-fail）降序取前五，供接收方评估
 * 技能可靠性；报告不携带任何运行时状态，纯派生事实。
 */
export function build_test_report(opts: {
  name: string;
  version: number;
  domain: string;
  model_id: string;
  hit_count: number;
  fail_count: number;
  success_rate: number;
  evidence_snapshot: readonly Record<string, unknown>[];
  kind: string;
  now: number;
}): Record<string, unknown> {
  const ordered = [...opts.evidence_snapshot].sort(
    (a, b) =>
      (Number(b['success_count'] ?? 0) - Number(b['fail_count'] ?? 0)) -
      (Number(a['success_count'] ?? 0) - Number(a['fail_count'] ?? 0)),
  );
  const sampleEdges = ordered.slice(0, 5).map((row) => ({
    src_type: row['src_type'],
    dst_type: row['dst_type'],
    success_count: Number(row['success_count'] ?? 0),
    fail_count: Number(row['fail_count'] ?? 0),
  }));
  return {
    skill_name: opts.name,
    version: opts.version,
    skill_kind: opts.kind,
    domain: opts.domain,
    model_id: opts.model_id,
    success_rate: _round(opts.success_rate, 4),
    hit_count: opts.hit_count,
    fail_count: opts.fail_count,
    sample_edges: sampleEdges,
    generated_at: opts.now,
    note: '自动结晶：命中数达阈值且命中率达标（来源指纹缓存条目）',
  };
}
