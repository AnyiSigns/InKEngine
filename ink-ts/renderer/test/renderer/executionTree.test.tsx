/**
 * 执行树渲染组件测试（§7.6 展示语义：树渲染/折叠展开/组卡形态/摘要块）。
 *
 * 测什么：
 * - registerExecutionTreeRenderers 注册 execution_tree_card；
 * - 回执头行（标题/根 scope/终态/子执行数/成本）、卡片默认折叠不见子节点；
 * - 展开 = 根开态（hop 明细/组卡结构直接可见），一级子卡行可见且各自折叠，
 *   点击子卡行展开其明细；
 * - 协作者组卡（席位行 + 归并契约行）与圆桌审议卡（意见互见行）形态差异；
 * - 子执行失败/降级 → 前台摘要块（折叠态可见）+ 点入复盘 → 展开并开到该子卡；
 * - 汇总摘要行的点入复盘展开全树；blocked 横幅、全绿无摘要块、空 bindValue
 *   不崩、多回执列表。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ExecutionTreeCard,
  ExecutionTreeFace,
  registerExecutionTreeRenderers,
} from '@/renderer/executionTree';
import { isComponentRegistered } from '@/renderer/componentRegistry';
import type { ExecutionReceipt } from '@/shared/session/executionTypes';

function fanOutReceipt(withCrossRead: boolean, rootBlocked = false): ExecutionReceipt {
  return {
    run_id: 'r-main',
    blocked: rootBlocked,
    block_reason: rootBlocked ? '转场审批拒绝' : null,
    outcome: rootBlocked ? 'failure' : 'degraded',
    final_product: { conclusion: '综合结论已收敛' },
    degraded_summaries: rootBlocked ? [] : ['worker_b 降级交付'],
    runs: [
      {
        run_id: 'r-main', parent_run_id: null, entry_scope: 'main', outcome: rootBlocked ? 'failure' : 'degraded',
        hops: [{ from: 'main', to: 'worker_a', shape: 'fan_out', commit: 'full', count: 2 }],
        cost: { steps: 3, tokens: 300 }, error: null,
      },
      {
        run_id: 'r-a', parent_run_id: 'r-main', entry_scope: 'worker_a', outcome: 'success',
        hops: [], cost: { steps: 1, tokens: 100 }, error: null,
      },
      {
        run_id: 'r-b', parent_run_id: 'r-main', entry_scope: 'worker_b', outcome: 'degraded',
        hops: [{ from: 'worker_b', to: 'worker_b_sub', shape: 'delegate' }],
        cost: { steps: 1, tokens: 80 }, error: '超时降级',
      },
    ],
    events: [
      { run_id: 'r-main', parent_run_id: null, scope: 'main', action: 'route:fan_out', detail: null },
      { run_id: 'r-main', parent_run_id: null, scope: 'main', action: 'merge', detail: { contract: 'full', adopted: 2 } },
      { run_id: 'r-a', parent_run_id: 'r-main', scope: 'worker_a', action: 'whiteboard_audit', detail: { scope: 'worker_a', block_id: 'wb-2', kind: 'opinion', action: 'write' } },
      { run_id: 'r-b', parent_run_id: 'r-main', scope: 'worker_b', action: 'whiteboard_audit', detail: { scope: 'worker_b', block_id: 'wb-3', kind: 'opinion', action: 'write' } },
      ...(withCrossRead
        ? [{ run_id: 'r-b', parent_run_id: 'r-main', scope: 'worker_b', action: 'whiteboard_audit', detail: { scope: 'worker_b', block_id: 'wb-2', kind: 'opinion', action: 'read' } }]
        : []),
    ],
    trails: [],
  };
}

function runNode(container: HTMLElement, runId: string): Element | null {
  return container.querySelector(`[data-ui="execution_run_node"][data-run-id="${runId}"]`);
}

/** 展开/收起回执卡（点头行）。 */
async function toggleCard(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
  await user.click(container.querySelector('[data-ui="execution_tree_header"]')!);
}

/** 展开指定子卡行。 */
async function openNode(user: ReturnType<typeof userEvent.setup>, container: HTMLElement, runId: string) {
  const row = runNode(container, runId);
  expect(row).not.toBeNull();
  await user.click(row!.querySelector(':scope > [data-ui="execution_run_toggle"]')!);
}

describe('注册入口与挂载面', () => {
  it('execution_tree_card 注册进动态组件注册表', () => {
    registerExecutionTreeRenderers();
    expect(isComponentRegistered('execution_tree_card')).toBe(true);
  });

  it('空绑定（无回执）不占位、不崩', () => {
    const { container } = render(<ExecutionTreeFace bindValue={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('多回执列表渲染（每回执一张卡）', () => {
    const { container } = render(
      <ExecutionTreeFace bindValue={[fanOutReceipt(false), { ...fanOutReceipt(false), run_id: 'r-x' }]} />,
    );
    expect(container.querySelectorAll('[data-ui="execution_tree_card"]')).toHaveLength(2);
  });
});

describe('执行树卡：折叠/展开（后台执行默认折叠）', () => {
  it('头行 = 标题/根 scope/终态/子执行数；默认折叠不见树体', () => {
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(false)} />);
    expect(screen.getByText('执行树')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="execution_root_scope"]')!.textContent).toContain('main');
    expect(container.querySelector('[data-ui="execution_root_outcome"]')!.textContent).toContain('降级');
    expect(container.textContent).toContain('2 个子执行');
    expect(container.querySelector('[data-ui="execution_tree_body"]')).toBeNull();
    expect(container.querySelectorAll('[data-ui="execution_run_node"]')).toHaveLength(0);
  });

  it('点击展开 = 根开态：一级子卡行可见且各自折叠；再点收起', async () => {
    const user = userEvent.setup();
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(false)} />);
    await toggleCard(user, container);
    const body = container.querySelector('[data-ui="execution_tree_body"]');
    expect(body).not.toBeNull();
    expect(body!.getAttribute('data-run-id')).toBe('r-main');
    const scopes = Array.from(container.querySelectorAll('[data-ui="execution_run_node"]'))
      .map((n) => n.getAttribute('data-run-id'));
    expect(scopes).toEqual(['r-a', 'r-b']);
    expect(container.querySelector('[data-ui="execution_final_product"]')!.textContent).toContain('综合结论已收敛');
    await toggleCard(user, container);
    expect(container.querySelector('[data-ui="execution_tree_body"]')).toBeNull();
  });

  it('展开态根明细可见 hop 行（fan_out ×2）；子卡行点击展开其明细', async () => {
    const user = userEvent.setup();
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(false)} />);
    await toggleCard(user, container);
    // 根开态：根 hop 明细直接可见（无需再点根）
    expect(container.querySelector('[data-ui="execution_hops"]')!.textContent).toContain('fan_out ×2');
    // 子卡折叠态无明细行；展开 worker_b 见其 delegate hop 与错误
    expect(runNode(container, 'r-b')!.querySelector('[data-ui="execution_run_detail"]')).toBeNull();
    await openNode(user, container, 'r-b');
    expect(runNode(container, 'r-b')!.getAttribute('data-open')).toBe('true');
    expect(runNode(container, 'r-b')!.querySelector('[data-ui="execution_run_detail"]')).not.toBeNull();
    expect(runNode(container, 'r-b')!.querySelector('[data-ui="execution_run_error"]')!.textContent).toContain('超时降级');
  });
});

describe('组卡形态差异（协作者组卡 / 圆桌审议卡）', () => {
  it('blind 并行 = 协作者组卡：席位行 + 归并契约行（互不可见）', async () => {
    const user = userEvent.setup();
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(false)} />);
    await toggleCard(user, container);
    expect(container.querySelector('[data-ui="execution_collab_group_body"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="execution_roundtable_body"]')).toBeNull();
    expect(container.querySelectorAll('[data-ui="execution_seat"]')).toHaveLength(2);
    expect(container.querySelector('[data-ui="execution_group_meta"]')!.textContent).toContain('契约 full');
    expect(container.querySelector('[data-ui="execution_group_meta"]')!.textContent).toContain('采纳 2');
  });

  it('意见块跨席位互读 = 圆桌审议卡（互见意见行）', async () => {
    const user = userEvent.setup();
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(true)} />);
    await toggleCard(user, container);
    expect(container.querySelector('[data-ui="execution_roundtable_body"]')).not.toBeNull();
    expect(container.querySelector('[data-ui="execution_group_meta"]')!.textContent).toContain('意见 2 条 · 读 1 次');
  });
});

describe('子执行失败/降级 → 前台摘要块 + 点入复盘', () => {
  it('折叠态摘要块可见（问题行含 scope/原因 + 汇总摘要行）', () => {
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(false)} />);
    const summary = container.querySelector('[data-ui="execution_degraded_summary"]');
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain('worker_b');
    expect(summary!.textContent).toContain('超时降级');
    expect(summary!.textContent).toContain('worker_b 降级交付');
    expect(container.querySelectorAll('[data-ui="execution_review_link"]')).toHaveLength(1);
  });

  it('点入复盘：展开执行树并开至该子执行卡', async () => {
    const user = userEvent.setup();
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(false)} />);
    await user.click(screen.getByText('点入复盘', { selector: '[data-ui="execution_review_link"]' }));
    expect(container.querySelector('[data-ui="execution_tree_body"]')).not.toBeNull();
    const target = runNode(container, 'r-b');
    expect(target).not.toBeNull();
    expect(target!.getAttribute('data-open')).toBe('true');
    // 未点到的兄弟子卡保持折叠
    expect(runNode(container, 'r-a')!.getAttribute('data-open')).toBeNull();
  });

  it('汇总摘要行的点入复盘：展开全部子卡（无 run 归属回落全树展开）', async () => {
    const user = userEvent.setup();
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(false)} />);
    await user.click(container.querySelectorAll('[data-ui="execution_review_expand_all"]')[0]);
    expect(container.querySelector('[data-ui="execution_tree_body"]')).not.toBeNull();
    expect(runNode(container, 'r-a')!.getAttribute('data-open')).toBe('true');
    expect(runNode(container, 'r-b')!.getAttribute('data-open')).toBe('true');
  });

  it('blocked 回执：阻断横幅可见；全绿回执无摘要块', () => {
    const { container } = render(<ExecutionTreeCard receipt={fanOutReceipt(false, true)} />);
    expect(container.querySelector('[data-ui="execution_blocked_reason"]')!.textContent).toContain('转场审批拒绝');
    const { container: green } = render(
      <ExecutionTreeCard
        receipt={{
          ...fanOutReceipt(false),
          outcome: 'success',
          degraded_summaries: [],
          runs: fanOutReceipt(false).runs.map((r) => ({ ...r, outcome: 'success' as const, error: null })),
        }}
      />,
    );
    expect(green.querySelector('[data-ui="execution_degraded_summary"]')).toBeNull();
  });
});
