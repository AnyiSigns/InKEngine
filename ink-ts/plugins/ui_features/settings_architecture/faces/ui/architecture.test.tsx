import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ArchitectureView } from './ArchitectureView';
import { EdgeEvidenceTab } from './tabs/EdgeEvidenceTab';
import type { ArchitectureBackend, EdgeSnapshotData } from '@app/views/architecture/backend';

function makeBackend(edges: EdgeSnapshotData | null): ArchitectureBackend {
  return {
    fetchEdgeEvidence: async () => edges,
  };
}

function edgeData(rows: EdgeSnapshotData['edges'] = []): EdgeSnapshotData {
  return { available: true, edges: rows };
}

describe('架构视图容器', () => {
  it('呈现边证据读取面（结点池 tab 已随 pool_governance 退役；模板假演示已移除）', async () => {
    render(<ArchitectureView backend={makeBackend(edgeData([{
      src_type: 'a', dst_type: 'b', src_contract_version: '1', dst_contract_version: '1',
      context_domain: 'default', success_count: 1, fail_count: 0, avg_cost: 0, policy: false,
      origin: 'runtime', last_used_at: null, created_at: 0,
    }]))} />);
    expect(await screen.findByTestId('edge-row-a-b')).toBeInTheDocument();
  });
});

describe('架构·边证据 tab（edge_evidence.list 投影）', () => {
  it('空证据 → 空态', async () => {
    render(<EdgeEvidenceTab backend={makeBackend({ available: false, edges: [] })} />);
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
    render(<EdgeEvidenceTab backend={makeBackend(data)} />);
    expect(await screen.findByText(/intent_parse → answer_generate/)).toBeInTheDocument();
    expect(screen.getByText(/成功 8 \/ 失败 1/)).toBeInTheDocument();
    expect(screen.getByTestId('edge-policy')).toBeInTheDocument();
  });
});