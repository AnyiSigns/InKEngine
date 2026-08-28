export interface SkillEvidence {
  src_type: string;
  dst_type: string;
  src_contract_version: string;
  dst_contract_version: string;
  context_domain: string;
  success_count: number;
  fail_count: number;
}

export interface SkillTestReport {
  skill_name: string;
  version: number;
  skill_kind: string;
  domain: string;
  model_id: string;
  success_rate: number;
  hit_count: number;
  fail_count: number;
  sample_edges: Array<{ src_type: string; dst_type: string; success_count: number; fail_count: number }>;
  generated_at: number;
  note: string;
}

export interface SkillContractNode {
  type: string;
  contract: {
    version: string;
    input_schema: { name: string; fields: Array<{ name: string; required: boolean; kind: string }> };
    output_schema: { name: string; fields: Array<{ name: string; required: boolean; kind: string }> };
  };
}

export interface SkillEntry {
  id: string;
  name: string;
  kind: string;
  domain: string;
  version: number;
  description: string;
  fingerprint: string;
  source_path: string;
  model_id: string;
  hit_count: number;
  fail_count: number;
  contract_snapshot: Array<[string, string]>;
  evidence_snapshot: SkillEvidence[];
  path: { nodes: Record<string, SkillContractNode> };
  test_report: SkillTestReport;
}

export interface SkillsMarketData {
  premounted: boolean;
  mount_policy: { required: string[]; note: string };
  skills: SkillEntry[];
}

export function validateSkillsMarket(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, errors: ['market 应为对象'] };
  }
  const market = value as Record<string, unknown>;
  if (typeof market.premounted !== 'boolean') errors.push('premounted 应为布尔');
  const policy = market.mount_policy as Record<string, unknown> | undefined;
  if (!policy || typeof policy !== 'object') {
    errors.push('mount_policy 缺失');
  } else {
    if (!Array.isArray(policy.required)) errors.push('mount_policy.required 应为数组');
    if (typeof policy.note !== 'string') errors.push('mount_policy.note 应为字符串');
  }
  const skills = market.skills as unknown[] | undefined;
  if (!Array.isArray(skills)) {
    errors.push('skills 应为数组');
    return { ok: false, errors };
  }
  const ids = new Set<string>();
  skills.forEach((entry, index) => {
    const prefix = `skills[${index}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${prefix} 应为对象`);
      return;
    }
    const s = entry as Record<string, unknown>;
    const need = (cond: boolean, msg: string) => { if (!cond) errors.push(`${prefix}.${msg}`); };
    need(typeof s.id === 'string' && (s.id as string).length > 0, 'id 非空字符串');
    need(typeof s.name === 'string' && (s.name as string).length > 0, 'name 非空字符串');
    need(typeof s.kind === 'string', 'kind 应为字符串');
    need(typeof s.description === 'string', 'description 应为字符串');
    need(typeof s.hit_count === 'number', 'hit_count 应为数字');
    need(typeof s.fail_count === 'number', 'fail_count 应为数字');
    if (typeof s.id === 'string') {
      if (ids.has(s.id)) errors.push(`${prefix}.id 重复：${s.id}`);
      ids.add(s.id);
    }
  });
  return { ok: errors.length === 0, errors };
}

export function successRate(skill: SkillEntry): number {
  const total = skill.hit_count + skill.fail_count;
  if (total === 0) return 0;
  return (skill.hit_count / total) * 100;
}

export function crystalSourceLabel(skill: SkillEntry): string {
  return `自动结晶 · 命中 ${skill.hit_count} 次 · 成功率 ${successRate(skill).toFixed(0)}%`;
}
