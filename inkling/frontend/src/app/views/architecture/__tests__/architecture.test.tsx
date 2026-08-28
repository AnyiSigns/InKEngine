import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ArchitectureView } from '@/app/views/architecture/ArchitectureView';
import { EdgeEvidenceTab } from '@/app/views/architecture/tabs/EdgeEvidenceTab';
import { PoolTab } from '@/app/views/architecture/tabs/PoolTab';
import { InstanceTab } from '@/app/views/architecture/tabs/InstanceTab';
import { createMockArchitectureBackend } from '@/app/views/architecture/mockBackend';
import type { DagGraph } from '@/app/dag';
import type { WorkflowTemplate, EdgeEvidence, InstanceGraph, PoolNode, GovernanceVerdict } from '@/app/views/architecture/backend';

const tplGraph: DagGraph = {
  nodes: [
    { id: 'n1', label: '编排', kind: 'orchestrator' },
    { id: 'n2', label: '工具', kind: 'tool' },
    { id: 'n3', label: '终结', kind: 'terminal' },
  ],
  edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }],
};

const template: WorkflowTemplate = {
  id: 't1',
  name: '研究链',
  description: '默认研究工序',
  graph: tplGraph,
  constraintDomain: ['研究', '开发'],
};

describe('架构·模板 tab', () => {
  it('编辑→校验→canary 回执文案→落链=参考（偏好权重非强制）', async () => {
    const user = userEvent.setup();
    render(<ArchitectureView backend={createMockArchitectureBackend({ templates: [template] })} />);
    await screen.findByTestId('tpl-row-t1');
    await user.click(screen.getByTestId('tpl-validate'));
    expect(await screen.findByTestId('tpl-validation-ok')).toBeInTheDocument();

    await user.click(screen.getByTestId('tpl-canary'));
    expect(await screen.findByText('结构校验通过 · 不承诺行为正确')).toBeInTheDocument();

    await user.click(screen.getByTestId('tpl-apply'));
    const applied = await screen.findByTestId('tpl-applied');
    expect(applied).toHaveTextContent('已启用（参考）：路由倾向走它，实际效果随使用验证');
    expect(applied).toHaveAttribute('data-reference', 'true');
  });

  it('约束校验失败→即时错误行（建议改模板/路由重选）', async () => {
    const user = userEvent.setup();
    render(<ArchitectureView backend={createMockArchitectureBackend({ templates: [template] })} />);
    await screen.findByTestId('tpl-row-t1');
    await user.click(screen.getByTestId('constraint-研究'));
    await user.click(screen.getByTestId('constraint-开发'));
    await user.click(screen.getByTestId('tpl-validate'));
    const err = await screen.findByTestId('tpl-validation-error');
    expect(err).toHaveTextContent('模板不满足当前任务约束');
    expect(err).toHaveTextContent('建议改模板');
  });

  it('diff 三色：增=朱砂 / 删=警示 / 改=中性', async () => {
    const user = userEvent.setup();
    render(<ArchitectureView backend={createMockArchitectureBackend({ templates: [template] })} />);
    await screen.findByTestId('tpl-row-t1');
    await user.click(screen.getByTestId('tpl-apply'));
    const diff = await screen.findByTestId('tpl-diff');
    expect(within(diff).getByText('+ step: research')).toHaveClass('w3-diff-add');
    expect(within(diff).getByText('- step: legacy')).toHaveClass('w3-diff-del');
    expect(within(diff).getByText('~ step: draft')).toHaveClass('w3-diff-mod');
  });
});

describe('架构·实例 tab（只读 + node_start 追踪）', () => {
  const instance: InstanceGraph = {
    roundId: 'r-9',
    graph: tplGraph,
    nodeStatus: { n1: 'success', n2: 'running', n3: 'failed' },
  };

  it('只读渲染且携带执行态', async () => {
    const user = userEvent.setup();
    render(<ArchitectureView backend={createMockArchitectureBackend({ instance })} />);
    await user.click(screen.getByTestId('arch-tab-instance'));
    expect(await screen.findByText('实例图（只读）')).toBeInTheDocument();
    expect(await screen.findByTestId('dag-node-n1')).toHaveAttribute('data-status', 'success');
    expect(screen.getByTestId('dag-node-n2')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('dag-node-n3')).toHaveAttribute('data-status', 'failed');
  });

  it('无实例数据→空态不白屏', async () => {
    render(<InstanceTab backend={createMockArchitectureBackend({ instance: null })} />);
    expect(await screen.findByText('暂无本回合实例图')).toBeInTheDocument();
  });
});

describe('架构·结点池 tab', () => {
  it('无治理数据→空态「治理数据暂不可用」', async () => {
    render(<PoolTab backend={createMockArchitectureBackend({ pool: { governance: null, nodes: null, verdicts: [] } })} />);
    expect(await screen.findByText('治理数据暂不可用')).toBeInTheDocument();
  });

  it('展示容量/预算/死亡标记', async () => {
    const nodes: PoolNode[] = [
      { name: 'nodeA', safetyTier: 'allow', version: '1.0', usageCount: 3, dead: false },
      { name: 'nodeB', safetyTier: 'deny', version: '0.9', usageCount: 0, dead: true },
    ];
    const verdicts: GovernanceVerdict[] = [{ id: 'v1', action: 'merge', at: 1, detail: '近重复合并' }];
    render(<PoolTab backend={createMockArchitectureBackend({ pool: { governance: { used: 128, total: 500, domain: '研究', weeklyUsed: 2, weeklyTotal: 3, weeklyPeriod: '周' }, nodes, verdicts } })} />);
    const cap = await screen.findByTestId('pool-capacity');
    expect(cap.textContent).toBe('128/500');
    expect(screen.getByTestId('pool-budget').textContent).toBe('2/3');
    expect(screen.getByTestId('pool-node-nodeB')).toHaveAttribute('data-dead', 'true');
  });
});

describe('架构·边证据 tab（双模式 + 信任档分节）', () => {
  const edges: EdgeEvidence[] = [
    { id: 'e1', from: 'a', to: 'b', trustTier: 'observe', score: { phat: 0.3, w: 1, dt: 0.9, tau: 0.7 } },
    { id: 'e2', from: 'b', to: 'c', trustTier: 'normal', score: { phat: 0.8, w: 1, dt: 0.9, tau: 0.7 }, promotion: { at: 1, note: '晋升' } },
    { id: 'e3', from: 'c', to: 'd', trustTier: 'promoted', score: { phat: 0.95, w: 1, dt: 0.9, tau: 0.7 } },
  ];

  it('标准模式=空态提示（不显「当前模式」整词）', async () => {
    render(<EdgeEvidenceTab backend={createMockArchitectureBackend({ edges })} assemblyResult={null} onOpenAssembly={() => undefined} />);
    const empty = await screen.findByTestId('edge-assembly-empty');
    expect(empty).toHaveTextContent('组装模式未开启');
    expect(empty).toHaveTextContent('去输入行开启组装');
  });

  it('组装模式=最近组装回合结果 + 信任档三态分节', async () => {
    render(
      <EdgeEvidenceTab
        backend={createMockArchitectureBackend({ edges })}
        assemblyResult={{ roundId: 'r-7', candidates: [{ path: 'p1', score: 0.6 }], junction: { verdict: '汇流', score: 0.7 } }}
      />,
    );
    expect(await screen.findByTestId('edge-assembly-result')).toBeInTheDocument();
    const rows = screen.getAllByTestId('edge-row-e1');
    expect(rows[0]).toHaveAttribute('data-trust', 'observe');
    expect(screen.getByTestId('edge-row-e2')).toHaveAttribute('data-trust', 'normal');
    expect(screen.getByTestId('edge-row-e3')).toHaveAttribute('data-trust', 'promoted');
  });

  it('评分下钻抽屉展示 p̂/w/d(t)/τ 四分量（不合成单一评分）', async () => {
    const user = userEvent.setup();
    render(<EdgeEvidenceTab backend={createMockArchitectureBackend({ edges })} assemblyResult={null} />);
    await user.click(await screen.findByTestId('edge-row-e1'));
    const drawer = await screen.findByTestId('edge-drawer');
    expect(within(drawer).getByTestId('edge-phat')).toHaveTextContent('0.3');
  });
});
