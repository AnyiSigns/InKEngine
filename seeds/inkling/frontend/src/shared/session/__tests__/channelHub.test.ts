/**
 * 通道中枢与事件落位测试：细粒度订阅 / 事件流指标 / 消息流增量渲染数据面。
 */

import { ChannelHub } from '@/shared/session/channelHub';
import { ingestEvent } from '@/shared/session/eventIngest';
import type { HubEvent } from '@/shared/session/channelHub';

function ev(type: HubEvent['type'], payload: Record<string, unknown> = {}): HubEvent {
  return { type, payload, at: Date.now() };
}

describe('ChannelHub 细粒度订阅', () => {
  it('events.* 按类型订阅互不干扰', () => {
    const hub = new ChannelHub();
    const received: string[] = [];
    const offThinking = hub.onEvent('thinking_start', () => received.push('thinking'));
    const offReply = hub.onEvent('reply_token', () => received.push('reply'));

    hub.dispatch(ev('thinking_start'));
    hub.dispatch(ev('reply_token', { token: 'a' }));
    hub.dispatch(ev('reply_token', { token: 'b' }));

    expect(received).toEqual(['thinking', 'reply', 'reply']);

    offThinking();
    hub.dispatch(ev('thinking_start'));
    expect(received).toEqual(['thinking', 'reply', 'reply']);
    offReply();
  });

  it('事件指标聚合（total/tokens/lastAt）', () => {
    const hub = new ChannelHub();
    hub.dispatch(ev('reply_token', { token: '你好' }));
    hub.dispatch(ev('reply_token', { token: '世界' }));
    hub.dispatch(ev('end'));
    const metrics = hub.getSnapshot().eventMetrics;
    expect(metrics.total).toBe(3);
    expect(metrics.tokens).toBe(4);
    expect(metrics.lastAt).toBeGreaterThan(0);
  });

  it('state.* 快照变更通知订阅者（getSnapshot/subscribe 契约）', () => {
    const hub = new ChannelHub();
    let notified = 0;
    const off = hub.subscribeState(() => {
      notified += 1;
    });
    hub.setState({ streaming: true });
    expect(notified).toBe(1);
    expect(hub.getSnapshot().streaming).toBe(true);
    off();
    hub.setState({ streaming: false });
    expect(notified).toBe(1);
  });

  it('inspect_* 快照独立订阅与更新', () => {
    const hub = new ChannelHub();
    let seen: number | undefined;
    const off = hub.subscribeInspect('inspect_graph', () => {
      const snapshot = hub.getInspect('inspect_graph');
      if ('version' in snapshot) seen = snapshot.version;
    });
    hub.setInspect('inspect_graph', { version: 5, nodes: [], edges: [], patchChain: [] });
    expect(seen).toBe(5);
    off();
  });
});

describe('事件落位（ingest）', () => {
  it('reply_token 追加到同一 streaming 消息（增量渲染数据面）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('reply_token', { step_id: 'reply:1', token: '第一' }));
    ingestEvent(hub, ev('reply_token', { step_id: 'reply:1', token: '段' }));
    const messages = hub.getSnapshot().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'streaming', content: '第一段' });
  });

  it('thinking_start/end 建卡定型，round_id 归属', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('thinking_start', { step_id: 'think:1' }));
    ingestEvent(hub, ev('thinking_end', { step_id: 'think:1', content: '观察中' }));
    const messages = hub.getSnapshot().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'thinking', status: 'completed', content: '观察中' });
  });

  it('tool_start/end 工具调用内联行（工具名/权限/结果摘要）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('tool_start', { step_id: 'tool:1', tool: 'inspect_knowledge', permission: 'allow' }));
    ingestEvent(hub, ev('tool_end', { step_id: 'tool:1', tool: 'inspect_knowledge', summary: '2 条知识', success: true }));
    const messages = hub.getSnapshot().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'tool', tool: 'inspect_knowledge', toolStatus: 'done', summary: '2 条知识' });
  });

  it('review_card 事件 → 弹层数据 + pendingReview 落位', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('review_card', { title: '补丁审批', reason: '请求应用' }));
    expect(hub.getSnapshot().pendingReview).toMatchObject({ title: '补丁审批' });
    expect(hub.getSnapshot().messages.at(-1)).toMatchObject({ kind: 'review_card', live: true });
  });

  it('memory_hit → knowledge_hit 消息 + 来源留痕', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('memory_hit', { hits: [{ id: 'k-1', title: '条目', snippet: '片段' }] }));
    const snapshot = hub.getSnapshot();
    expect(snapshot.messages.at(-1)).toMatchObject({ kind: 'knowledge_hit' });
    expect(snapshot.sourceTraces).toHaveLength(1);
    expect(snapshot.sourceTraces[0]).toMatchObject({ sourceType: 'memory', knowledgeId: 'k-1' });
  });

  it('孵化/推演/补丁事件落位（孵化流水 + 分支 + 补丁链）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('signal_observed', { signal_id: 'sig-1', signal_type: 'insight', signal: '信号' }));
    ingestEvent(hub, ev('gate_verdict', { signal_id: 'sig-1', level: 'L1', passed: false, reason: '样例不足' }));
    expect(hub.getSnapshot().incubation[0]).toMatchObject({ stage: 'blocked', gateLevel: 'L1' });

    ingestEvent(hub, ev('simulate_decision', { branches: [{ branch_id: 'b-1', label: '甲', score: 0.8 }] }));
    ingestEvent(hub, ev('swap_branch', { branch_id: 'b-1' }));
    expect(hub.getSnapshot().simulations[0]).toMatchObject({ branchId: 'b-1', selected: true });

    ingestEvent(hub, ev('patch_proposed', { patch_id: 'p-1', kind: 'rule', title: '规则补丁' }));
    ingestEvent(hub, ev('patch_reverted', { patch_id: 'p-1', reason: '链尾回退' }));
    expect(hub.getSnapshot().patchChain[0]).toMatchObject({ status: 'reverted', revertReason: '链尾回退' });
  });

  it('未登记事件类型折叠兜底不崩', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, { type: 'unknown_future_event', payload: { x: 1 }, at: 0 } as never);
    expect(hub.getSnapshot().messages.at(-1)).toMatchObject({ kind: 'unknown' });
  });

  it('end 事件不建卡（静默）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('end'));
    expect(hub.getSnapshot().messages).toHaveLength(0);
  });
});
