/**
 * W7E web 执行树接线测试（execution.run 回执 → 会话视图）。
 *
 * 测什么：
 * - 槽位注入：execution_tree_card 节点进 chat 列（task_capsule 之前）、幂等、
 *   无 root 原样返回；
 * - dispatchExecutionRun：假后端回执落位当前窗口（state.executionRuns 与
 *   会话桶双写）、回执形态非法拒绝落位、下发失败错误上屏（消息流 error 行）、
 *   宿主不可用直拒；
 * - 主壳装配链路：注入后的 ui.generated.json → UIRenderer → 假数据执行树卡
 *   渲染进会话视图；默认折叠态（后台执行）、点击展开树、失败子执行点入复盘
 *   展开该卡；无回执不占位（消息流照常渲染）。
 */

import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChannelHub } from '@/shared/session/channelHub';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ExecutionReceipt } from '@/shared/session/executionTypes';
import { registerBuiltinComponents } from '@/components';
import { registerPluginFaces } from '@app/pluginFaces.generated';
import { UIRenderer } from '@/renderer/bootRenderer';
import type { UINode, UISpec } from '@/renderer/uiSpecTypes';
import {
  EXECUTION_TREE_COMPONENT,
  injectExecutionViewSlot,
} from '@app/shell/executionViewSlot';
import { dispatchExecutionRun } from '@app/state/executionWiring';

import uiLayout from '../../../../plugins/ui.generated.json';

/** 递归找首个匹配节点（布局注入断言用）。 */
function findNode(node: UINode | null, pred: (n: UINode) => boolean): UINode | null {
  if (!node) return null;
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, pred);
    if (hit) return hit;
  }
  return null;
}

function chatColumnOf(spec: UISpec): UINode | null {
  return findNode(spec.root, (n) => n.kind === 'container' && n.props?.view === 'chat');
}

function receiptFixture(): ExecutionReceipt {
  return {
    run_id: 'r-main',
    blocked: false,
    block_reason: null,
    outcome: 'degraded',
    final_product: { conclusion: '执行完成（有降级）' },
    degraded_summaries: ['worker_b 降级交付'],
    runs: [
      {
        run_id: 'r-main', parent_run_id: null, entry_scope: 'main', outcome: 'degraded',
        hops: [{ from: 'main', to: 'worker_a', shape: 'fan_out', commit: 'full', count: 2 }],
        cost: { steps: 4, tokens: 400 }, error: null,
      },
      { run_id: 'r-a', parent_run_id: 'r-main', entry_scope: 'worker_a', outcome: 'success', hops: [], cost: { steps: 1 }, error: null },
      { run_id: 'r-b', parent_run_id: 'r-main', entry_scope: 'worker_b', outcome: 'failure', hops: [], cost: { steps: 1 }, error: '执行失败' },
    ],
    events: [
      { run_id: 'r-main', parent_run_id: null, scope: 'main', action: 'route:fan_out', detail: null },
      { run_id: 'r-main', parent_run_id: null, scope: 'main', action: 'merge', detail: { contract: 'full', adopted: 1 } },
    ],
    trails: [],
  };
}

function hubActive(id: string): ChannelHub {
  const hub = new ChannelHub();
  hub.setState({ activeSessionId: id });
  return hub;
}

/** 主壳 product 基线（同 specShell 冒烟夹具口径）。 */
const baseProduct: Record<string, unknown> = {
  backend: null,
  sessions: [],
  branchTrees: {},
  authorized: false,
  workspaceRoot: null,
  models: undefined,
  agentModelId: null,
  hasTodo: false,
  todoPending: 0,
  settingsOpen: false,
  roundCount: 0,
  stepCount: 0,
  onSend: () => undefined,
};

describe('执行树槽位注入（壳装配单点，不写布局 JSX）', () => {
  it('execution_tree_card 注入 chat 列且位于 task_capsule 之前（幂等、不改原对象）', () => {
    const base = uiLayout as unknown as UISpec;
    const injected = injectExecutionViewSlot(base);
    const children = chatColumnOf(injected)?.children ?? [];
    const at = children.findIndex((child) => child.type === EXECUTION_TREE_COMPONENT);
    expect(at).toBeGreaterThanOrEqual(0);
    const capsuleAt = children.findIndex((child) => child.type === 'task_capsule');
    expect(capsuleAt).toBeGreaterThan(at);
    expect(children[at].bind?.channel).toBe('state.executionRuns');
    // 原布局不被改写（返回新对象）
    expect((chatColumnOf(base)?.children ?? []).some((c) => c.type === EXECUTION_TREE_COMPONENT)).toBe(false);
    // 幂等：二次注入不重复
    const twice = injectExecutionViewSlot(injected);
    expect((chatColumnOf(twice)?.children ?? []).filter((c) => c.type === EXECUTION_TREE_COMPONENT)).toHaveLength(1);
  });

  it('无 root = 原样返回（不抛）', () => {
    const broken = { name: 'x', root: null } as unknown as UISpec;
    expect(injectExecutionViewSlot(broken)).toBe(broken);
  });
});

describe('dispatchExecutionRun（execution.run 回执 → 会话视图数据面）', () => {
  it('真回执：解析落位当前窗口（全局镜像 + 会话桶双写）', async () => {
    const hub = hubActive('t1');
    const backend = {
      available: true,
      executionRun: async () => JSON.parse(JSON.stringify(receiptFixture())),
    } as unknown as BackendAdapter;
    const result = await dispatchExecutionRun(hub, backend, 't1', { task: '召集评审' });
    expect(result.ok).toBe(true);
    expect(hub.getSnapshot().executionRuns.map((r) => r.run_id)).toEqual(['r-main']);
    expect(hub.getSnapshot().perThread['t1'].executionRuns).toHaveLength(1);
  });

  it('回执形态非法 = 拒绝落位并上屏（ok:false，不崩）', async () => {
    const hub = hubActive('t1');
    const backend = { available: true, executionRun: async () => ({ nonsense: true }) } as unknown as BackendAdapter;
    const result = await dispatchExecutionRun(hub, backend, 't1', { task: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('执行回执形态非法');
    expect(hub.getSnapshot().executionRuns).toEqual([]);
    expect(hub.getSnapshot().messages.some((m) => m.kind === 'error')).toBe(true);
  });

  it('下发异常：错误落回发起线程消息流（appendRoundError 同口径）', async () => {
    const hub = hubActive('t1');
    const backend = {
      available: true,
      executionRun: async () => { throw new Error('执行运行时未装配'); },
    } as unknown as BackendAdapter;
    const result = await dispatchExecutionRun(hub, backend, 't1', { task: 'x' });
    expect(result.ok).toBe(false);
    const errors = hub.getSnapshot().messages.filter((m) => m.kind === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { content: string }).content).toContain('执行运行时未装配');
  });

  it('宿主不可用直拒（不产回执）', async () => {
    const hub = hubActive('t1');
    const backend = { available: false } as unknown as BackendAdapter;
    const result = await dispatchExecutionRun(hub, backend, 't1', { task: 'x' });
    expect(result.ok).toBe(false);
    expect(hub.getSnapshot().executionRuns).toEqual([]);
  });
});

describe('会话视图渲染链路（假数据树 + 折叠态 + 点入复盘）', () => {
  it('回执落位后主壳渲染执行树卡：默认折叠、可展开、失败子卡点入复盘展开', async () => {
    const user = userEvent.setup();
    registerBuiltinComponents();
    registerPluginFaces();
    const hub = hubActive('t1');
    hub.setState({ executionRuns: [receiptFixture()] });
    const spec = injectExecutionViewSlot(uiLayout as unknown as UISpec);
    const { container } = render(
      <UIRenderer spec={spec} hub={hub} activeView="chat" product={baseProduct} />,
    );
    const card = container.querySelector('[data-ui="execution_tree_card"]');
    expect(card).not.toBeNull();
    // 折叠态（后台执行默认折叠）：树体未渲染，前台摘要块可见
    expect(container.querySelector('[data-ui="execution_tree_body"]')).toBeNull();
    expect(card!.querySelector('[data-ui="execution_degraded_summary"]')!.textContent).toContain('worker_b');
    // 展开假数据树：一级子卡两行（worker_a / worker_b）可见（根开态由卡展开承载）
    await user.click(card!.querySelector('[data-ui="execution_tree_header"]')!);
    expect(container.querySelector('[data-ui="execution_tree_body"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-ui="execution_run_node"]').length).toBe(2);
    expect(container.querySelector('[data-ui="execution_hops"]')!.textContent).toContain('fan_out');
    // 点入复盘：展开链开到失败子执行卡
    const reviewLink = card!.querySelector('[data-ui="execution_review_link"]');
    expect(reviewLink).not.toBeNull();
    await user.click(reviewLink!);
    const failedRow = container.querySelector('[data-ui="execution_run_node"][data-run-id="r-b"]');
    expect(failedRow!.getAttribute('data-open')).toBe('true');
  });

  it('无回执数据：槽位不占可见面（消息流照常渲染）', () => {
    registerBuiltinComponents();
    registerPluginFaces();
    const hub = hubActive('t1');
    const spec = injectExecutionViewSlot(uiLayout as unknown as UISpec);
    const { container } = render(
      <UIRenderer spec={spec} hub={hub} activeView="chat" product={baseProduct} />,
    );
    expect(container.querySelector('[data-ui="execution_tree_card"]')).toBeNull();
    expect(container.querySelector('[data-ui="input_send"]')).not.toBeNull();
  });
});
