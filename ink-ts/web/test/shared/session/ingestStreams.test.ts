/**
 * 事件落位扩展测试：推理流式分片追加、工具原始参数整理、附件落位。
 */

import { ChannelHub } from '@/shared/session/channelHub';
import { ingestEvent, submitAttachments } from '@/shared/session/eventIngest';
import type { HubEvent } from '@/shared/session/channelHub';

function ev(type: HubEvent['type'], payload: Record<string, unknown> = {}): HubEvent {
  return { type, payload, at: Date.now() };
}

describe('推理流式（thinking_start 分片追加，中途可见）', () => {
  it('同 stepId 分片逐片追加到运行中的思考条目', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('thinking_start', { step_id: 'think:1', content: '观察' }));
    ingestEvent(hub, ev('thinking_start', { step_id: 'think:1', content: '当前领域' }));
    ingestEvent(hub, ev('thinking_start', { step_id: 'think:1', content: '缺口' }));
    const messages = hub.getSnapshot().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'thinking', status: 'running', content: '观察当前领域缺口' });
  });

  it('thinking_end 定型为完成态（内容收敛）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('thinking_start', { step_id: 'think:1', content: '观察' }));
    ingestEvent(hub, ev('thinking_end', { step_id: 'think:1', content: '观察完毕' }));
    expect(hub.getSnapshot().messages[0]).toMatchObject({ kind: 'thinking', status: 'completed', content: '观察完毕' });
  });

  it('分片期间其它事件可见（中途事件不因推理进行被遮挡/合并）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('thinking_start', { step_id: 'think:1', content: '推理中' }));
    ingestEvent(hub, ev('tool_start', { step_id: 'tool:1', tool: 'inspect_knowledge', permission: 'allow' }));
    const messages = hub.getSnapshot().messages;
    expect(messages.map((m) => m.kind)).toEqual(['thinking', 'tool']);
  });
});

describe('工具原始参数', () => {
  it('tool_start 对象参数格式化为 JSON 文本（供展开查看）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('tool_start', { step_id: 'tool:1', tool: 'file_read', permission: 'allow', parameters: { path: '~/a.txt' } }));
    expect(hub.getSnapshot().messages[0]).toMatchObject({
      kind: 'tool',
      tool: 'file_read',
      args: expect.stringContaining('"path"'),
    });
  });

  it('无参数时不产生 args 字段', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('tool_start', { step_id: 'tool:1', tool: 'inspect_graph', permission: 'allow' }));
    expect(hub.getSnapshot().messages[0]).toMatchObject({ args: undefined });
  });
});

describe('推演决策（simulate_decision 消费引擎实际结构）', () => {
  it('branches 数组 + selected 索引 → 模拟分支表', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('simulate_decision', {
      node: 'simulate:1',
      step_id: 'sim:1',
      selected: [1],
      branches: [
        { index: 0, description: '直接收口', score: 0.4, passed: false, note: '证据不足' },
        { index: 1, description: '先检索再回答', score: 0.9, passed: true, note: '证据充分' },
      ],
    }));
    const sims = hub.getSnapshot().simulations;
    expect(sims).toHaveLength(2);
    expect(sims[0]).toMatchObject({ branchId: '0', label: '直接收口', score: 0.4, selected: false, rationale: '证据不足' });
    expect(sims[1]).toMatchObject({ branchId: '1', label: '先检索再回答', score: 0.9, selected: true, rationale: '证据充分' });
  });

  it('selected 缺失时回落首分支选中', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('simulate_decision', {
      branches: [{ index: 0, description: 'A', score: 0.5 }],
    }));
    expect(hub.getSnapshot().simulations[0].selected).toBe(true);
  });
});

describe('规划卡（plan_start 消费引擎 plan 数组）', () => {
  it('plan 步骤数组 → workflow 展示标签（步骤名连接）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('plan_start', { plan: [{ nodes: ['plan'] }, { nodes: ['tool'] }] }));
    expect(hub.getSnapshot().messages[0]).toMatchObject({ kind: 'plan', status: 'running', workflow: 'plan, tool' });
  });

  it('plan 缺失时 workflow 为空', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('plan_start', {}));
    expect(hub.getSnapshot().messages[0]).toMatchObject({ kind: 'plan', workflow: undefined });
  });
});

describe('附件落位（submitAttachments）', () => {
  it('图片/视频/文档各自为独立条目', () => {
    const hub = new ChannelHub();
    submitAttachments(hub, [
      { kind: 'image', name: 'a.png', mime: 'image/png', size: 1, url: 'https://cdn.example.org/a.png' },
      { kind: 'video', name: 'b.mp4', mime: 'video/mp4', size: 2, url: '~/inkling/attachments/b.mp4' },
      { kind: 'document', name: 'c.md', mime: 'text/markdown', size: 3, url: '~/inkling/attachments/c.md' },
    ]);
    const messages = hub.getSnapshot().messages;
    expect(messages.map((m) => m.kind)).toEqual(['image', 'video', 'document']);
    expect(messages[1]).toMatchObject({ mime: 'video/mp4', size: 2 });
  });

  it('空资产不落位', () => {
    const hub = new ChannelHub();
    submitAttachments(hub, []);
    expect(hub.getSnapshot().messages).toHaveLength(0);
  });
});

describe('tool_start title 通道', () => {
  it('事件载荷 title 落位工具消息（渲染以 title 为准）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('tool_start', { step_id: 'tool:1', tool: 'fetch', permission: 'allow', title: '网络抓取' }));
    expect(hub.getSnapshot().messages[0]).toMatchObject({ kind: 'tool', tool: 'fetch', title: '网络抓取' });
  });

  it('无 title 载荷 = 不落 title 字段（渲染走本地兜底链）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('tool_start', { step_id: 'tool:1', tool: 'inspect_graph', permission: 'allow' }));
    expect(hub.getSnapshot().messages[0]).toMatchObject({ title: undefined });
  });

  it('空字符串 title 视为缺省（不覆盖既有 title）', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, ev('tool_start', { step_id: 'tool:1', tool: 'fetch', permission: 'allow', title: '网络抓取' }));
    ingestEvent(hub, ev('tool_start', { step_id: 'tool:1', tool: 'fetch', permission: 'allow', title: '' }));
    expect(hub.getSnapshot().messages[0]).toMatchObject({ title: '网络抓取' });
  });
});

describe('组装时间线入轨迹（assembly_started/done 折叠为一条组装步骤）', () => {
  it('assembly_started → done 折叠为一条「组装」步骤，done 携带耗时', () => {
    const hub = new ChannelHub();
    const startedAt = Date.now() - 2000;
    ingestEvent(hub, { type: 'turn_started', payload: { round_id: 'r1' }, at: startedAt });
    ingestEvent(hub, { type: 'assembly_started', payload: { ts: startedAt / 1000 }, at: startedAt });
    ingestEvent(hub, {
      type: 'assembly_done',
      payload: { ts: (startedAt + 1500) / 1000 },
      at: startedAt + 1500,
    });
    ingestEvent(hub, { type: 'execution_started', payload: { node: 'produce', ts: (startedAt + 1600) / 1000 }, at: startedAt + 1600 });
    const steps = hub.getSnapshot().roundSteps;
    const assembly = steps.find((s) => s.stepId === 'assembly');
    expect(assembly).toBeDefined();
    expect(assembly).toMatchObject({ type: 'assembly', label: '组装', status: 'done' });
    expect(assembly?.elapsedMs).toBeCloseTo(1500, -1);
    // 只折叠一条（不因 execution_started 重复建卡）
    expect(steps.filter((s) => s.type === 'assembly')).toHaveLength(1);
  });

  it('未启用组装时 execution_started 不凭空建组装卡', () => {
    const hub = new ChannelHub();
    ingestEvent(hub, { type: 'execution_started', payload: { node: 'produce' }, at: Date.now() });
    expect(hub.getSnapshot().roundSteps.filter((s) => s.type === 'assembly')).toHaveLength(0);
  });
});
