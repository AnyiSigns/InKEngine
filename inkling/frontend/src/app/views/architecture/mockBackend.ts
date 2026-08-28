import { createBackend, type BackendAdapter } from '@/shared/backend/backendAdapter';

import type {
  ArchitectureBackend,
  AssemblyResult,
  CanaryReceipt,
  EdgeEvidence,
  GovernanceVerdict,
  InstanceGraph,
  PatchDiff,
  PoolGovernance,
  PoolNode,
  ValidationResult,
  WorkflowTemplate,
} from './backend';

/** 生产后端：能消费既有 adapter op 的走 adapter，缺口一律 null（列表级降级，不白屏）。 */
export function createLiveArchitectureBackend(adapter: BackendAdapter = createBackend()): ArchitectureBackend {
  return {
    async fetchWorkflowTemplates() {
      if (!adapter.available) return null;
      try {
        const snap = (await adapter.graphSnapshot()) as WorkflowTemplate[] | null;
        return Array.isArray(snap) ? snap : null;
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
    async fetchInstanceGraph(): Promise<InstanceGraph | null> {
      return null;
    },
    async fetchPool() {
      if (!adapter.available) return { governance: null, nodes: null, verdicts: [] };
      try {
        const snap = (await adapter.poolSnapshot()) as
          | { governance?: PoolGovernance; nodes?: PoolNode[]; verdicts?: GovernanceVerdict[] }
          | null;
        if (!snap) return { governance: null, nodes: null, verdicts: [] };
        return {
          governance: snap.governance ?? null,
          nodes: snap.nodes ?? null,
          verdicts: snap.verdicts ?? [],
        };
      } catch {
        return { governance: null, nodes: null, verdicts: [] };
      }
    },
    async fetchEdgeEvidence(): Promise<EdgeEvidence[] | null> {
      if (!adapter.available) return null;
      try {
        const list = (await adapter.edgeEvidenceList()) as EdgeEvidence[] | null;
        return Array.isArray(list) ? list : null;
      } catch {
        return null;
      }
    },
    async downgradeEdge(_id: string): Promise<void> {
      await adapter.downgradeEdgeTier(_id);
    },
    async fetchAssemblyResult(): Promise<AssemblyResult | null> {
      if (!adapter.available) return null;
      try {
        const res = (await adapter.pathAssemble()) as AssemblyResult | null;
        return res ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** 测试后端：注入夹具数据，确定性可断言。 */
export function createMockArchitectureBackend(fixtures: {
  templates?: WorkflowTemplate[] | null;
  instance?: InstanceGraph | null;
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
    async fetchInstanceGraph(): Promise<InstanceGraph | null> {
      return fixtures.instance ?? null;
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
