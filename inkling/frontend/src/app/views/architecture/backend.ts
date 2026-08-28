import type { DagGraph, DagNodeStatus } from '@/app/dag';

/** 工具四源/安全档（语义，不暴露机器术语于用户视图）。 */
export type SafetyTier = 'allow' | 'review' | 'deny';

/** workflow 模板（编辑主对象）。 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** workflow.json 链 + graph.json 骨架 + harness 物化的 DAG。 */
  graph: DagGraph;
  /** 计划时约束域（确定性校验）。 */
  constraintDomain: string[];
}

/** 结构校验结果（计划时约束校验）。 */
export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** canary 试跑回执（结构门禁，不承诺行为正确）。 */
export interface CanaryReceipt {
  passed: boolean;
  /** 固定文案：「结构校验通过 · 不承诺行为正确」。 */
  text: string;
}

/** 落链结果（落链=参考：路由倾向走它，实际效果随使用验证）。 */
export interface ApplyResult {
  appliedAt: number;
  /** 固定文案：「已启用（参考）：路由倾向走它，实际效果随使用验证」。 */
  text: string;
}

/** 补丁链 diff 行（增=朱砂/删=警示/改=中性）。 */
export type DiffOp = 'add' | 'del' | 'mod';
export interface DiffLine {
  op: DiffOp;
  text: string;
}
export interface PatchDiff {
  title: string;
  lines: DiffLine[];
}

/** 实例图（只读，最近回合实际跑的图）。 */
export interface InstanceGraph {
  roundId: string;
  graph: DagGraph;
  /** node_start/end 推进的执行态。 */
  nodeStatus: Record<string, DagNodeStatus>;
}

/** 结点池治理读数（E5 接线后可用；未接线=null → 降级空态）。 */
export interface PoolGovernance {
  used: number;
  total: number;
  domain: string;
  weeklyUsed: number;
  weeklyTotal: number;
  weeklyPeriod: string;
}
export interface PoolNode {
  name: string;
  safetyTier: SafetyTier;
  version: string;
  usageCount: number;
  dead: boolean;
}
export interface GovernanceVerdict {
  id: string;
  action: string;
  at: number;
  detail: string;
}

/** 边证据信任档。 */
export type TrustTier = 'observe' | 'normal' | 'promoted';
export interface EdgeScore {
  /** 推荐先验晋升留痕分量：p̂·w·d(t)·τ。 */
  phat: number;
  w: number;
  dt: number;
  tau: number;
}
export interface EdgeEvidence {
  id: string;
  from: string;
  to: string;
  trustTier: TrustTier;
  score: EdgeScore;
  /** recommended_prior_promotion 留痕。 */
  promotion?: { at: number; note: string };
  lastAssembly?: { roundId: string; rank: number; score: number };
}

/** 组装回合结果（标准模式不展示；组装模式展示最近一次）。 */
export interface AssemblyResult {
  roundId: string;
  candidates: Array<{ path: string; score: number }>;
  junction: { verdict: string; score: number };
}

/** 机制视图后端契约（mock 注入 / 生产降级回落）。 */
export interface ArchitectureBackend {
  fetchWorkflowTemplates(): Promise<WorkflowTemplate[] | null>;
  validateTemplate(t: WorkflowTemplate): Promise<ValidationResult>;
  runCanary(t: WorkflowTemplate): Promise<CanaryReceipt>;
  applyTemplate(t: WorkflowTemplate): Promise<ApplyResult>;
  fetchPatchDiff(t: WorkflowTemplate): Promise<PatchDiff | null>;
  fetchInstanceGraph(): Promise<InstanceGraph | null>;
  fetchPool(): Promise<{ governance: PoolGovernance | null; nodes: PoolNode[] | null; verdicts: GovernanceVerdict[] }>;
  fetchEdgeEvidence(): Promise<EdgeEvidence[] | null>;
  downgradeEdge(id: string): Promise<void>;
  fetchAssemblyResult(): Promise<AssemblyResult | null>;
}
