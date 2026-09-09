import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ArchitectureView } from './ArchitectureView';
import { EdgeEvidenceTab } from './tabs/EdgeEvidenceTab';
import { PoolTab } from './tabs/PoolTab';
import type { ArchitectureBackend, EdgeSnapshotData, PoolSnapshotData } from '@app/views/architecture/backend';

function makeBackend(pool: PoolSnapshotData | null, edges: EdgeSnapshotData | null): ArchitectureBackend {
  return {
    fetchPool: async () => pool,
    evaluateProposal: async (nodeId: string) => ({ available: true, evaluated: true, verdict: 'merge', node_id: nodeId }),
    fetchEdgeEvidence: async () => edges,
  };
}

function poolData(partial: Partial<PoolSnapshotData> = {}): PoolSnapshotData {
  return {
    available: true,
    counts: {
      pool_count: 3,
      evaluations: 4,
      dead_node_candidates: 1,
      near_duplicate_merges: 2,
      weekly_budget_used: 3,
      weekly_budget_remaining: 7,
      verdict_counts: { merge: 2, split: 1 },
    },
    last_round: { node_id: 'nodeA', verdict: 'merge', ts: 1700000000, budget_remaining: 7 },
    rows: [{ node_id: 'nodeA', verdict: 'merge', ts: 1700000000, budget_remaining: 7, reasons: ['近重复'] }],
    registry: {
      available: true,
      total_count: 2,
      active_count: 2,
      types: [
        { type_name: 'llm_decider', status: 'active', provenance: 'seed', executor: 'engine:llm_decider' },
        { type_name: 'tool_pipeline', status: 'active', provenance: 'seed', executor: 'engine:tool_pipeline' },
      ],
    },
    degraded: false,
    ...partial,
  };
}

function edgeData(rows: EdgeSnapshotData['edges'] = []): EdgeSnapshotData {
  return { available: true, edges: rows };
}

describe('架构视图容器', () => {
  it('只含结点池/边证据 tab（模板假演示已移除）', async () => {
    render(<ArchitectureView backend={makeBackend(poolData(), edgeData())} />);
    expect(screen.getByTestId('arch-tab-pool')).toBeInTheDocument();
    expect(screen.getByTestId('arch-tab-edge')).toBeInTheDocument();
    expect(screen.queryByTestId('arch-tab-template')).toBeNull();
  });
});

describe('架构·结点池 tab（pool.snapshot 投影）', () => {
  it('无治理数据 → 空态「治理数据暂不可用」', async () => {
    render(<PoolTab backend={makeBackend({ available: false, counts: { pool_count: 0, evaluations: 0, dead_node_candidates: 0, near_duplicate_merges: 0, weekly_budget_used: 0, weekly_budget_remaining: null, verdict_counts: {} }, last_round: null, rows: [], registry: { available: false, total_count: 0, active_count: 0, types: [] }, degraded: true }, null)} />);
    expect(await screen.findByText('治理数据暂不可用')).toBeInTheDocument();
  });

  it('展示容量/预算/死结点候选/判定计数', async () => {
    render(<PoolTab backend={makeBackend(poolData(), null)} />);
    const cap = await screen.findByTestId('pool-capacity');
    expect(cap.textContent).toContain('3');
    expect(screen.getByTestId('pool-budget').textContent).toContain('3');
    expect(screen.getByTestId('pool-dead-count').textContent).toContain('1');
    expect(screen.getByTestId('pool-verdict-merge')).toBeInTheDocument();
  });

  it('评估入口只登记：输入 node_id → 调 evaluateProposal 并展示判定', async () => {
    const backend = makeBackend(poolData(), null);
    const evalSpy = vi.spyOn(backend, 'evaluateProposal');
    render(<PoolTab backend={backend} />);
    await screen.findByTestId('pool-capacity');
    const input = screen.getByTestId('pool-candidate-input');
    fireEvent.change(input, { target: { value: 'nodeX' } });
    fireEvent.click(screen.getByTestId('pool-evaluate'));
    await waitFor(() => {
      expect(evalSpy).toHaveBeenCalledWith('nodeX');
    });
    expect(await screen.findByTestId('pool-evaluation')).toBeTruthy();
  });
});

describe('架构·边证据 tab（edge_evidence.list 投影）', () => {
  it('空证据 → 空态', async () => {
    render(<EdgeEvidenceTab backend={makeBackend(null, { available: false, edges: [] })} />);
    expect(await screen.findByText('暂无边证据')).toBeInTheDocument();
  });

  it('渲染边证据行：src→dst + 成功/失败计数 + 策略标记', async () => {
    const data = edgeData([
      {
        src_type: 'intent_parse',
        dst_type: 'answer_generate',
        src_contract_version: '1',
        dst_contract_version: '1',
        context_domain: 'research',
        success_count: 8,
        fail_count: 1,
        avg_cost: 0.5,
        policy: true,
        origin: 'runtime',
        last_used_at: 1700000000,
        created_at: 1690000000,
      },
    ]);
    render(<EdgeEvidenceTab backend={makeBackend(null, data)} />);
    expect(await screen.findByText(/intent_parse → answer_generate/)).toBeInTheDocument();
    expect(screen.getByText(/成功 8 \/ 失败 1/)).toBeInTheDocument();
    expect(screen.getByTestId('edge-policy')).toBeInTheDocument();
  });
});
