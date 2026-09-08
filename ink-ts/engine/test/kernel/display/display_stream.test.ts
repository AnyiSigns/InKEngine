/**
 * 事件展示流聚合器单测：从事件流（thinking/tool/reply_token）派生 display_messages。
 * 展示态独立于上下文 messages（不喂模型）；按 step_id 聚合。
 */

import { describe, expect, it } from 'vitest';

import { DisplayStreamCollector } from '../../../src/kernel/display/display_stream.js';
import { EngineEvent } from '../../../src/core/events/events.js';

function ev(type: string, payload: Record<string, unknown>, step_id: string | null = null, round_id: string | null = 'r1'): EngineEvent {
  return new EngineEvent({ type, payload, step_id, round_id, thread_id: 't', node: 'llm_decider' });
}

describe('DisplayStreamCollector（事件展示流聚合）', () => {
  it('thinking_start 分片追加 + thinking_end 定型 completed', async () => {
    const c = new DisplayStreamCollector();
    await c.send(ev('thinking_start', { content: '', status: 'running' }, 'think:1'));
    await c.send(ev('thinking_start', { content: '让我', status: 'running' }, 'think:1'));
    await c.send(ev('thinking_start', { content: '想想', status: 'running' }, 'think:1'));
    await c.send(ev('thinking_end', { content: '', status: 'completed' }, 'think:1'));
    const msgs = c.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'thinking', content: '让我想想', status: 'completed' });
    expect(msgs[0]!['step_id']).toMatch(/^display:\d+$/);
  });

  it('tool_start → tool_end 建卡并定型 done + 输出', async () => {
    const c = new DisplayStreamCollector();
    await c.send(ev('tool_start', { tool: 'inspect_graph', args: '{"x":1}', permission: '' }, 'tool:call-1'));
    await c.send(ev('tool_end', { tool: 'inspect_graph', success: true, summary: '图快照' }, 'tool:call-1'));
    const msgs = c.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'tool', tool: 'inspect_graph', toolStatus: 'done', args: '{"x":1}', summary: '图快照' });
  });

  it('tool_end 失败定型 error', async () => {
    const c = new DisplayStreamCollector();
    await c.send(ev('tool_start', { tool: 'grep', args: '', permission: '' }, 'tool:call-2'));
    await c.send(ev('tool_end', { tool: 'grep', success: false, error: '找不到' }, 'tool:call-2'));
    const msgs = c.getMessages();
    expect(msgs[0]).toMatchObject({ kind: 'tool', tool: 'grep', toolStatus: 'error', summary: '找不到' });
  });

  it('reply_token 按 round 拼接 assistant 正文', async () => {
    const c = new DisplayStreamCollector();
    await c.send(ev('reply_token', { token: '你' }, null, 'r1'));
    await c.send(ev('reply_token', { token: '好' }, null, 'r1'));
    await c.send(ev('reply_token', { token: '！' }, null, 'r1'));
    const msgs = c.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'text', role: 'assistant', content: '你好！' });
  });

  it('混合流顺序保持 + 多 step_id 聚合并行条目', async () => {
    const c = new DisplayStreamCollector();
    await c.send(ev('thinking_start', { content: '想', status: 'running' }, 'think:1'));
    await c.send(ev('thinking_end', { content: '', status: 'completed' }, 'think:1'));
    await c.send(ev('tool_start', { tool: 'a', args: '', permission: '' }, 'tool:1'));
    await c.send(ev('tool_end', { tool: 'a', success: true, summary: 'ok' }, 'tool:1'));
    await c.send(ev('reply_token', { token: '正文' }, null, 'r1'));
    const msgs = c.getMessages();
    expect(msgs.map((m) => m['kind'])).toEqual(['thinking', 'tool', 'text']);
    // 多 step_id 思考：两个独立 think 卡
    await c.send(ev('thinking_start', { content: '再想', status: 'running' }, 'think:2'));
    await c.send(ev('thinking_end', { content: '', status: 'completed' }, 'think:2'));
    expect(c.getMessages().filter((m) => m['kind'] === 'thinking')).toHaveLength(2);
  });
});
