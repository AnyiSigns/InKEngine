/**
 * 技能导出（skill_crystal.py export_skill 移植）：技能 → 可分享 JSON 结构，
 * 技能市场导入与该导出同构。
 *
 * 导出体 = 技能元数据 + 路径定义 + 测试报告 + 来源指纹。core 零 IO：
 * Python 的 ``dest`` 落盘参数为宿主职责（返回结构后由调用方决定落点，
 * 宿主测试承载文件 IO），本面只产结构。
 */

import { SkillEntry } from './skill_entry.js';

/**
 * 导出技能为可分享 JSON 结构（技能市场导入与该导出同构）。
 * 返回结构含 format=inkling.skill/v1 版本头，供接收方判定解析器。
 */
export function export_skill(entry: SkillEntry): Record<string, unknown> {
  return {
    format: 'inkling.skill/v1',
    name: entry.name,
    version: entry.version,
    domain: entry.domain,
    kind: entry.kind,
    fingerprint: entry.fingerprint,
    source_path: entry.source_path,
    model_id: entry.model_id,
    hit_count: entry.hit_count,
    fail_count: entry.fail_count,
    contract_snapshot: entry.contract_snapshot.map((pair) => [pair[0], pair[1]]),
    evidence_snapshot: entry.evidence_snapshot.map((row) => ({ ...row })),
    path: { ...entry.path },
    test_report: { ...entry.test_report },
  };
}
