import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';
import type { DagGraph, DagNode } from '@/app/dag';

import type {
  ArchitectureBackend,
  AssemblyResult,
  CanaryReceipt,
  EdgeEvidence,
  GovernanceVerdict,
  PatchDiff,
  PoolGovernance,
  PoolNode,
  ValidationResult,
  WorkflowTemplate,
} from './backend';
import { dagNodeKind } from './backend';

/** 边信任档映射（引擎 observing/regular/promoted → 前端 observe/normal/promoted）。 */
function trustTier(tier: string | undefined): EdgeEvidence['trustTier'] {
  if (tier === 'observing') return 'observe';
  if (tier === 'regular') return 'normal';
  if (tier === 'promoted') return 'promoted';
  return 'normal';
}

/**
 * 生产后端：把 adapter op 的返回结构映射成视图类型（引擎结构 → 前端契约）。
 * op 返回结构不匹配时按视图类型空态降级，不把原始结构泄漏给渲染层。
 */
export function createLiveArchitectureBackend(adapter: BackendAdapter = createBackend()): ArchitectureBackend {
  return {
    async fetchWorkflowTemplates(): Promise<WorkflowTemplate[] | null> {
      if (!adapter.available) return null;
      try {
        const snap = (await adapter.graphSnapshot()) as
          | {
              version?: string;
              nodes?: Array<{ id: string; type?: string; label?: string }>;
              edges?: Array<{ from: string; to: string }>;
              degraded?: boolean;
            }
          | null;
        if (!snap || ((snap.degraded === true || (snap.nodes?.length ?? 0) === 0) && (snap.nodes?.length ?? 0) === 0)) {
          return null;
        }
        const nodes: DagNode[] = (snap.nodes ?? []).map((n) => ({
          id: n.id,
          label: n.label ?? n.id,
          kind: dagNodeKind(n.type),
        }));
        const graph: DagGraph = {
          nodes,
          edges: (snap.edges ?? []).map((e) => ({ from: e.from, to: e.to })),
        };
        return [
          {
            id: 'current',
            name: '当前回合图',
            description: `版本 ${snap.version ?? '—'} · 当前装配回合图`,
            graph,
            constraintDomain: [],
          },
        ];
      } catch {
        return null;
      }
    },
    async validateTemplate(_t: WorkflowTemplate): Promise<ValidationResult> {
      return { ok: true };
    },
    async runCanary(): Promise<CanaryReceipt> {
      return { passed: true, text: '结构校验通过 · 不承诺行为正确' };
    },
    async applyTemplate(): Promise<{ appliedAt: number; text: string }> {
      return { appliedAt: Date.now(), text: '已启用（参考）：路由倾向走它，实际效果随使用验证' };
    },
    async fetchPatchDiff(): Promise<PatchDiff | null> {
      return null;
    },
    async fetchPool(): Promise<{ governance: PoolGovernance | null; nodes: PoolNode[] | null; verdicts: GovernanceVerdict[] }> {
      if (!adapter.available) return { governance: null, nodes: null, verdicts: [] };
      try {
        const snap = (await adapter.poolSnapshot()) as
          | {
              pool_nodes?: Array<{ node_id?: unknown; usage_count?: unknown; promoted?: unknown; age_days?: unknown; domain?: unknown }>;
              governance_log?: Array<{ verdict?: unknown; reasons?: unknown; budget_remaining?: unknown }>;
            }
          | null;
        if (!snap) return { governance: null, nodes: null, verdicts: [] };
        const nodes: PoolNode[] = (snap.pool_nodes ?? []).map((n) => ({
          name: String(n.node_id ?? ''),
          safetyTier: n.promoted ? 'allow' : 'review',
          version: '',
          usageCount: Number(n.usage_count ?? 0),
          dead: false,
        }));
        const verdicts: GovernanceVerdict[] = (snap.governance_log ?? []).map((v, i) => ({
          id: `g-${i}`,
          action: String(v.verdict ?? ''),
          at: 0,
          detail: Array.isArray(v.reasons) ? v.reasons.map(String).join('；') : '',
        }));
        return {
          governance: nodes.length
            ? {
                used: nodes.length,
                total: nodes.length,
                domain: 'default',
                weeklyUsed: 0,
                weeklyTotal: 0,
                weeklyPeriod: '—',
              }
            : null,
          nodes: nodes.length ? nodes : null,
          verdicts,
        };
      } catch {
        return { governance: null, nodes: null, verdicts: [] };
      }
    },
    async fetchEdgeEvidence(): Promise<EdgeEvidence[] | null> {
      if (!adapter.available) return null;
      try {
        const snap = (await adapter.edgeEvidenceList()) as
          | { edges?: Array<{ src_type?: unknown; dst_type?: unknown; tier?: unknown; p?: unknown; weight?: unknown; decay?: unknown; tau?: unknown }> }
          | null;
        const list = snap?.edges ?? [];
        if (!list.length) return null;
        return list.map((e) => ({
          id: `${e.src_type}|${e.dst_type}`,
          from: String(e.src_type ?? ''),
          to: String(e.dst_type ?? ''),
          trustTier: trustTier(String(e.tier ?? '')),
          score: {
            phat: Number(e.p ?? 0),
            w: Number(e.weight ?? 0),
            dt: Number(e.decay ?? 0),
            tau: Number(e.tau ?? 0),
          },
        }));
      } catch {
        return null;
      }
    },
    async downgradeEdge(id: string): Promise<void> {
      await adapter.downgradeEdgeTier(id);
    },
    async fetchAssemblyResult(): Promise<AssemblyResult | null> {
      if (!adapter.available) return null;
      try {
        const res = (await adapter.pathAssemble()) as
          | {
              ok?: boolean;
              enabled?: boolean;
              candidates?: Array<{ path?: unknown; score?: unknown }>;
              junction?: { verdict?: unknown; score?: unknown };
            }
          | null;
        if (!res || res.ok === false) return null;
        return {
          roundId: 'current',
          candidates: (res.candidates ?? []).map((c) => ({ path: String(c.path ?? ''), score: Number(c.score ?? 0) })),
          junction: { verdict: String(res.junction?.verdict ?? '—'), score: Number(res.junction?.score ?? 0) },
        };
      } catch {
        return null;
      }
    },
  };
}

/** 测试后端：注入夹具数据，确定性可断言。 */
export function createMockArchitectureBackend(fixtures: {
  templates?: WorkflowTemplate[] | null;
  pool?: { governance: PoolGovernance | null; nodes: PoolNode[] | null; verdicts: GovernanceVerdict[] } | null;
  edges?: EdgeEvidence[] | null;
  assembly?: AssemblyResult | null;
}): ArchitectureBackend {
  return {
    async fetchWorkflowTemplates() {
      return fixtures.templates ?? null;
    },
    async validateTemplate(t: WorkflowTemplate): Promise<ValidationResult> {
      if (!t.constraintDomain.length) return { ok: false, error: '模板不满足当前任务约束' };
      return { ok: true };
    },
    async runCanary(): Promise<CanaryReceipt> {
      return { passed: true, text: '结构校验通过 · 不承诺行为正确' };
    },
    async applyTemplate(): Promise<{ appliedAt: number; text: string }> {
      return { appliedAt: Date.now(), text: '已启用（参考）：路由倾向走它，实际效果随使用验证' };
    },
    async fetchPatchDiff(): Promise<PatchDiff | null> {
      return {
        title: 'template.patch',
        lines: [
          { op: 'add', text: '+ step: research' },
          { op: 'del', text: '- step: legacy' },
          { op: 'mod', text: '~ step: draft' },
        ],
      };
    },
    async fetchPool() {
      return (
        fixtures.pool ?? {
          governance: null,
          nodes: null,
          verdicts: [],
        }
      );
    },
    async fetchEdgeEvidence(): Promise<EdgeEvidence[] | null> {
      return fixtures.edges ?? null;
    },
    async downgradeEdge(): Promise<void> {},
    async fetchAssemblyResult(): Promise<AssemblyResult | null> {
      return fixtures.assembly ?? null;
    },
  };
}
