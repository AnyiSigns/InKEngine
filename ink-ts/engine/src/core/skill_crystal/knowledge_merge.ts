/**
 * 技能 ⇄ 知识集合并容器互转（skill_crystal.py 合并容器函数移植）：
 * 技能 = 知识集 kind=path 条目（单一权威 = 知识集）。本文件承载
 * skill_to_knowledge_entry（技能 → 条目，条目 id = skill:<name>@v<version>）、
 * 载荷打包（技能值对象 → 存 data.skill，可无损重建）与
 * knowledge_entry_to_skill（条目 → 技能值对象，组装/导出/市场同构消费）。
 */

import { StorageError } from '../errors.js';
import { isRecord, type JsonRecord } from '../json.js';
import {
  KIND_PATH,
  LEVEL_PROJECT,
  SKILL_ID_PREFIX,
  SOURCE_MODEL,
  KnowledgeEntry,
} from '../knowledge_set/index.js';
import { SkillEntry } from './skill_entry.js';
import { _round, _success_rate } from './mechanism.js';
import { SKILL_KIND_PATH } from './_types.js';

/** 技能值对象 → 载荷 dict（存知识集 data.skill，可无损重建）。 */
function _skill_payload(skill: SkillEntry): Record<string, unknown> {
  return {
    name: skill.name,
    version: skill.version,
    domain: skill.domain,
    fingerprint: skill.fingerprint,
    kind: skill.kind,
    path: { ...skill.path },
    contract_snapshot: skill.contract_snapshot.map((pair) => [pair[0], pair[1]]),
    evidence_snapshot: skill.evidence_snapshot.map((row) => ({ ...row })),
    model_id: skill.model_id,
    hit_count: skill.hit_count,
    fail_count: skill.fail_count,
    test_report: { ...skill.test_report },
    source_path: skill.source_path,
  };
}

/**
 * 技能 → 知识集 path 条目（合并容器；条目 id = skill:<name>@v<version>）。
 *
 * 技能全量载荷进 data.skill；credibility = 成功率（统计证据背书）；
 * level = 项目级（路径知识属领域沉淀）；来源 = model（自动结晶）或由
 * 调用方覆写（市场安装经用户审批）。updated_at = 注入 now（结晶/写入时点）。
 */
export function skill_to_knowledge_entry(
  skill: SkillEntry,
  opts: { now: number },
): KnowledgeEntry {
  return new KnowledgeEntry({
    id: `${SKILL_ID_PREFIX}${skill.name}@v${skill.version}`,
    level: LEVEL_PROJECT,
    kind: KIND_PATH,
    data: { skill: _skill_payload(skill) } as unknown as JsonRecord,
    source: SOURCE_MODEL,
    credibility: _round(_success_rate(skill.hit_count, skill.fail_count), 2),
    title: skill.name,
    tags: ['skill', skill.domain, skill.kind],
    created_at: skill.created_at,
    updated_at: opts.now,
  });
}

/**
 * 知识集 path 条目 → 技能值对象（组装/导出/市场同构消费）。
 *
 * 载荷缺 skill 形态 = 显式拒绝（path 类目内的条目必带技能载荷）。
 */
export function knowledge_entry_to_skill(entry: KnowledgeEntry): SkillEntry {
  const data = isRecord(entry.data['skill']) ? entry.data['skill'] : null;
  if (data === null) {
    throw new StorageError(
      `知识条目 ${entry.id} 缺技能载荷（kind=path 须携 data.skill）`,
    );
  }
  const rawContract = Array.isArray(data['contract_snapshot'])
    ? data['contract_snapshot']
    : [];
  const contractSnapshot = rawContract.map((pair) => {
    const tuple = Array.isArray(pair) ? pair : [];
    return [String(tuple[0] ?? ''), String(tuple[1] ?? '')] as const;
  });
  const rawEvidence = Array.isArray(data['evidence_snapshot'])
    ? data['evidence_snapshot']
    : [];
  return new SkillEntry({
    name: String(data['name']),
    version: Number(data['version'] ?? 1),
    domain: String(data['domain'] ?? 'default'),
    fingerprint: String(data['fingerprint'] ?? ''),
    kind: String(data['kind'] ?? SKILL_KIND_PATH),
    path: isRecord(data['path']) ? { ...data['path'] } : {},
    contract_snapshot: contractSnapshot,
    evidence_snapshot: rawEvidence
      .filter(isRecord)
      .map((row) => ({ ...row })),
    model_id: String(data['model_id'] ?? ''),
    hit_count: Number(data['hit_count'] ?? 0),
    fail_count: Number(data['fail_count'] ?? 0),
    test_report: isRecord(data['test_report']) ? { ...data['test_report'] } : {},
    source_path: String(data['source_path'] ?? data['fingerprint'] ?? ''),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  });
}
