/**
 * W1.5 语言转译表：消息流可见术语全中文映射。
 * 机器术语仅白名单（来源视图/管理台）可保留原文。
 */

type TranslationParams = Record<string, string | number>;

const translations: Record<string, (params?: TranslationParams) => string> = {
  inspect_knowledge_allow: (p) => `知识检索 · 已放行 · ${p?.count ?? 0} 条相关记忆 · 可信度 ${p?.confidence ?? '?'}`,
  inspect_knowledge_review: (p) => `知识检索 · 待审核 · ${p?.count ?? 0} 条`,
  settle_proposed: (p) => `沉降提案 · ${p?.count ?? 0} 条待审批`,
  edge_evidence: (p) => `边证据 · 信任档 ${p?.tier ?? '?'}`,
  junction_verdict: (p) => `汇流裁决 · ${p?.verdict ?? '?'}`,
  assembly_candidate: (p) => `组装候选 · ${p?.count ?? 0} 条`,
  tool_start: (p) => `执行工具 · ${p?.name ?? '未知'}`,
  tool_end_ok: (p) => `工具完成 · ${p?.name ?? '未知'} · ${(p?.duration as number)?.toFixed(2) ?? '?'}s`,
  tool_end_error: (p) => `工具失败 · ${p?.name ?? '未知'} · ${p?.reason ?? '异常'}`,
  round_reply: () => '已回复',
  round_error: () => '出错',
  round_cancelled: () => '取消',
  round_budget_exceeded: () => '预算耗尽',
  round_aborted: () => '已中止',
  assembly_fallback_pulse: () => '组装未命中 · 已回落标准',
  assembly_fallback_note: () => '本回合请求组装 · 零候选回落标准',
  budget_guard: (p) => `预算 · 已用 ${Math.round((Number(p?.ratio ?? 0)) * 100)}%`,
  phase_capsule: (p) => `规划 · ${p?.steps ?? 0} 步`,
  chain_label_research: () => '研究链',
  chain_label_development: () => '开发链',
  chain_label_ops: () => '运维链',
  chain_label_direct: () => '直答',
};

export function t(key: string, params?: TranslationParams): string {
  const fn = translations[key];
  if (!fn) return key;
  return fn(params);
}

export const WHITE_LIST_RAW_TERMS = ['inspect_knowledge', 'settle_', 'edge_evidence', 'junction_verdict', 'assembly_candidate'];
