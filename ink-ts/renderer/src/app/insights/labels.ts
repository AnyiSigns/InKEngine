import type { AuditRecord } from './backend';

/** 事件类型 → 中文短标签（时间线徽标与描述用）。 */
export const TYPE_LABELS: Record<string, string> = {
  assembly_candidate: '组装候选',
  junction_verdict: '汇流裁决',
  junction_verdict_audit: '汇流裁决审计',
  assembly_audit: '组装审计',
  fingerprint_replace_audit: '缓存指纹顶替',
  policy_edge_review: '策略边复审',
  policy_edge_review_audit: '策略边复审',
  recommended_prior_promotion: '推荐先验晋升',
  failure_audit: '失败审计',
  revert: '补丁回退',
  signal_detected: '孵化信号',
  distill_outcome: '蒸馏产物',
  gate_verdict: '闸门判定',
  evolution_variant: '变异体',
  mutation_proposed: '变异提案',
  regression_guard: '防退化守卫',
  patch_proposed: '补丁提案',
  patch_applied: '补丁应用',
  patch_reverted: '补丁回退',
  tuning_update: '调优更新',
  vetting_result: 'vetting 结果',
  node_start: '节点执行',
  tool_audit: '工具审计',
  memory_recall: '记忆召回',
};

/** 类型 → 描述（reason/action 优先，其次 src→dst/candidate/tool）。 */
export function describeEntry(type: string, raw: AuditRecord): string {
  const label = TYPE_LABELS[type] ?? type;
  const reason = raw.reason ?? raw.action ?? raw.note;
  if (reason) return `${label}：${String(reason)}`;
  if (raw.src_type && raw.dst_type) return `${label}：${raw.src_type}→${raw.dst_type}`;
  if (raw.candidate_id) return `${label}：${raw.candidate_id}`;
  if (raw.tool) return `${label}：${raw.tool}`;
  return label;
}

const DETAIL_FIELDS: Array<[string, string]> = [
  ['reason', '理由'],
  ['action', '动作'],
  ['domain', '域'],
  ['candidate_id', '候选'],
  ['src_type', '源'],
  ['dst_type', '目标'],
  ['review_tier', '审批档'],
  ['tool', '工具'],
  ['signal_id', '信号'],
  ['patch_id', '补丁'],
  ['mutation_id', '变异'],
  ['level', '档位'],
  ['passed', '通过'],
  ['verdict', '判定'],
  ['note', '备注'],
  ['trace_id', 'trace'],
  ['thread_id', '线程'],
];

/** 条目详情（展开行）：挑已知字段拼成可读文本。 */
export function detailText(raw: AuditRecord): string {
  const parts: string[] = [];
  for (const [key, label] of DETAIL_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(`${label}: ${text}`);
  }
  return parts.join('\n');
}

/** 是否需要警示高亮（回退/失败/拦截）。 */
export function isAlertType(type: string, raw: AuditRecord): boolean {
  if (type === 'revert' || type === 'patch_reverted' || type === 'failure_audit') return true;
  if (type === 'gate_verdict' || type === 'regression_guard') {
    return raw.passed === false;
  }
  return false;
}
