/**
 * run_loop 白板穿透测试（grants/board 下发 → 子作用域授权视图 + 审计转发）。
 *
 * 测什么：
 * - 穿透：request.whiteboard（grants+blocks，main 召集时已写好任务块）随 run
 *   下发，main 自身 turn 与子执行 turn 均按自身 scope 取授权视图
 *   （ScopeTurnContext.whiteboard_blocks）；
 * - blind 隔离：意见块作者读自己、无跨读授权——两个子执行互不见对方意见
 *   （turn input 与审计两侧都不出现他人意见块）；
 * - main 全可见：主持人 turn input 含全部块；
 * - open 对照：跨读授权后子执行互见意见块；
 * - fan_out：N 路并行子执行各自取授权视图（任务块广播）；
 * - 审计转发：白板 view 产生的 read 审计经既有事件通道（RunEvent
 *   action='whiteboard_audit'，detail=scope×block_id×kind×action）到达，
 *   且 deps.on_whiteboard_audit 同步收到；
 * - 零漂移：无白板 run 的 turn 上下文无 whiteboard_blocks、事件带无
 *   whiteboard_audit，run 结果形态与既有行为一致。
 */
import { describe, expect, it } from 'vitest';

import { ChannelDirectory, default_channel_seeds } from '../../../src/model/channels/channel_directory.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { ExecutionRuntime } from '../../../src/core/execution_runtime/execution_runtime.js';
import type { ScopeTurnResult } from '../../../src/core/execution_runtime/scope_turn.js';
import type {
  ExecutionRuntimeDeps,
  ScopeTurnContext,
  WhiteboardSession,
} from '../../../src/core/execution_runtime/runtime_types.js';
import { default_whiteboard_grants } from '../../../src/core/whiteboard/index.js';
import type { WhiteboardBlock } from '../../../src/core/whiteboard/index.js';

function entity(id: string): EntitySpec {
  return new EntitySpec({ id, role: id, persona: `${id} 作用域`, model: null });
}

/** fake turn：按作用域剧本逐轮吐载荷，并捕获每次调用的上下文供断言。 */
class CapturingTurn {
  readonly calls: ScopeTurnContext[] = [];
  constructor(private script: Record<string, Array<Record<string, unknown>>>) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    this.calls.push(ctx);
    const item = this.script[ctx.scope.id]?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { message: '（缺省直答）' } };
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

const TASK_BLOCK: WhiteboardBlock = {
  id: 'b-task', kind: 'task', owner: 'main', content: '季度数据分析任务', seq: 0,
};
const OPINION_A: WhiteboardBlock = {
  id: 'b-op-a', kind: 'opinion', owner: 'collab_a', content: 'A的私密意见', seq: 1,
};
const OPINION_B: WhiteboardBlock = {
  id: 'b-op-b', kind: 'opinion', owner: 'collab_b', content: 'B的私密意见', seq: 2,
};

function wbSession(mode: 'blind' | 'open'): WhiteboardSession {
  return {
    grants: default_whiteboard_grants(mode, ['collab_a', 'collab_b']),
    blocks: [TASK_BLOCK, OPINION_A, OPINION_B],
  };
}

function deps(
  turn: CapturingTurn,
  extra: Partial<ExecutionRuntimeDeps> = {},
): ExecutionRuntimeDeps {
  const scopes = new Map<string, EntitySpec>(
    ['main', 'collab_a', 'collab_b', 'collaborator'].map((id) => [id, entity(id)]),
  );
  const channels = new ChannelDirectory();
  for (const spec of default_channel_seeds()) channels.register(spec);
  return {
    load_scope: (id) => scopes.get(id) ?? null,
    channels,
    turn,
    approval: async (): Promise<'accept' | 'auto' | 'reject'> => 'accept',
    ...extra,
  };
}

function turnCallsOf(turn: CapturingTurn, scopeId: string): ScopeTurnContext[] {
  return turn.calls.filter((c) => c.scope.id === scopeId);
}

describe('blind 隔离：两个子执行互不见对方意见，main 全可见', () => {
  it('collab_a/collab_b 的 turn input 各含任务块+自己意见，不含对方意见；main 含全部', async () => {
    const turn = new CapturingTurn({
      main: [
        { __next: { kind: 'scope', target: 'collab_a' } },
        { __next: { kind: 'scope', target: 'collab_b' } },
        { message: '两人意见裁决' },
      ],
      collab_a: [{ opinion: 'A 回传' }],
      collab_b: [{ opinion: 'B 回传' }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({ task: '召集协作', whiteboard: wbSession('blind') });
    expect(result.root.outcome).toBe('success');

    const mainInputs = turnCallsOf(turn, 'main').map((c) => c.input);
    expect(mainInputs[0]).toContain('季度数据分析任务');
    expect(mainInputs[0]).toContain('A的私密意见');
    expect(mainInputs[0]).toContain('B的私密意见');

    const aInput = turnCallsOf(turn, 'collab_a')[0]!.input;
    expect(aInput).toContain('季度数据分析任务');
    expect(aInput).toContain('A的私密意见');
    expect(aInput).not.toContain('B的私密意见');

    const bInput = turnCallsOf(turn, 'collab_b')[0]!.input;
    expect(bInput).toContain('季度数据分析任务');
    expect(bInput).toContain('B的私密意见');
    expect(bInput).not.toContain('A的私密意见');

    // 授权视图随 ScopeTurnContext 下发（块内容侧的镜像断言）
    expect(turnCallsOf(turn, 'collab_a')[0]!.whiteboard_blocks?.map((b) => b.kind)).toEqual([
      'task',
      'opinion',
    ]);
  });
});

describe('open 对照：跨读授权后子执行互见意见块', () => {
  it('open 模式下 collab_a 的 turn input 含 B 的意见', async () => {
    const turn = new CapturingTurn({
      main: [{ __next: { kind: 'scope', target: 'collab_a' } }, { message: '收尾' }],
      collab_a: [{ opinion: 'A 回传' }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    await runtime.run({ task: '圆桌', whiteboard: wbSession('open') });
    const aInput = turnCallsOf(turn, 'collab_a')[0]!.input;
    expect(aInput).toContain('A的私密意见');
    expect(aInput).toContain('B的私密意见');
  });
});

describe('审计转发：view 审计经既有事件通道到达', () => {
  it('whiteboard_audit 事件 detail=scope×block_id×kind×action；blind 下无跨读审计', async () => {
    const auditSink: Array<{ scope: string; block_id: string; kind: string; action: string }> = [];
    const turn = new CapturingTurn({
      main: [{ __next: { kind: 'scope', target: 'collab_a' } }, { message: '收尾' }],
      collab_a: [{ opinion: 'A 回传' }],
    });
    const runtime = new ExecutionRuntime(
      deps(turn, {
        on_whiteboard_audit: (entries) => {
          for (const e of entries) auditSink.push({ ...e });
        },
      }),
    );
    const result = await runtime.run({ task: '召集协作', whiteboard: wbSession('blind') });
    const wbEvents = result.events.filter((e) => e.action === 'whiteboard_audit');
    expect(wbEvents.length).toBeGreaterThan(0);
    expect(wbEvents.length).toBe(auditSink.length);

    const aReads = wbEvents.filter((e) => e.detail?.['scope'] === 'collab_a' && e.detail?.['action'] === 'read');
    const aReadBlocks = aReads.map((e) => e.detail?.['block_id']);
    expect(aReadBlocks).toContain('b-task');
    expect(aReadBlocks).toContain('b-op-a');
    expect(aReadBlocks).not.toContain('b-op-b');

    const mainReads = wbEvents.filter((e) => e.detail?.['scope'] === 'main' && e.detail?.['action'] === 'read');
    expect(mainReads.map((e) => e.detail?.['block_id'])).toContain('b-op-b');
    for (const e of wbEvents) {
      expect(e.run_id).not.toBe('');
      expect(['task', 'opinion', 'board', 'conclusion', 'summary']).toContain(e.detail?.['kind']);
    }
  });
});

describe('fan_out 穿透：N 路并行子执行各自取授权视图', () => {
  it('两路 collaborator 的 turn input 均含任务块（广播只读）', async () => {
    const turn = new CapturingTurn({
      main: [
        { __next: { kind: 'channel', channel: 'fan_out', target: 'collaborator', count: 2 } },
        { message: '双意见裁决' },
      ],
      collaborator: [{ opinion: 'o1' }, { opinion: 'o2' }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({
      task: '并行协作',
      whiteboard: {
        grants: default_whiteboard_grants('blind', ['collaborator']),
        blocks: [TASK_BLOCK],
      },
    });
    expect(result.root.outcome).toBe('success');
    const calls = turnCallsOf(turn, 'collaborator');
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.input).toContain('季度数据分析任务');
      expect(call.whiteboard_blocks?.some((b) => b.kind === 'task' && b.content === '季度数据分析任务')).toBe(true);
    }
  });
});

describe('零漂移：无白板 run 与既有行为一致', () => {
  it('turn 上下文无 whiteboard_blocks、事件带无 whiteboard_audit', async () => {
    const turn = new CapturingTurn({
      main: [{ __next: { kind: 'scope', target: 'collab_a' } }, { message: '收尾' }],
      collab_a: [{ answer: '子结果' }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({ task: '普通委托' });
    expect(result.root.outcome).toBe('success');
    expect(result.events.some((e) => e.action === 'whiteboard_audit')).toBe(false);
    for (const call of turn.calls) {
      expect(call.whiteboard_blocks).toBeUndefined();
    }
    expect(result.final_product['message']).toBe('收尾');
  });
});
