/**
 * 白板运行中改授权的运行时接线测试（run_loop `__amend` 结构化产物声明链路）。
 *
 * 测什么：
 * - main 声明 `__amend`（grant 意见互读）→ 仲裁生效：后续子执行 turn 的授权
 *   视图即时放大（blind 板升格共享案例）；amendment 审计经既有事件通道
 *   （action='whiteboard_audit'，detail.kind='amendment'，含变更清单与理由）与
 *   deps.on_whiteboard_audit 双路到达；产物无 `__amend` 残留；
 * - 非仲裁者作用域声明 `__amend` → 不生效且该子 run fail-closed 判失败
 *   （错误面含仲裁者判定），板授权零变化；
 * - 结构非法声明（kind≠'amend' 等）→ 显式拒绝判失败；
 * - 零漂移：无白板 run 的 `__amend` 键被消费不抛错、不残留产物、不发审计事件。
 */
import { describe, expect, it } from 'vitest';

import { ChannelDirectory, default_channel_seeds } from '../../../src/core/channels/channel_directory.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { ExecutionRuntime } from '../../../src/core/execution_runtime/execution_runtime.js';
import type { ScopeTurnResult } from '../../../src/core/execution_runtime/scope_turn.js';
import type {
  ExecutionRuntimeDeps,
  ScopeTurnContext,
  WhiteboardSession,
} from '../../../src/core/execution_runtime/runtime_types.js';
import { default_whiteboard_grants } from '../../../src/core/whiteboard/index.js';
import type { WhiteboardAuditEntry, WhiteboardBlock } from '../../../src/core/whiteboard/index.js';

function entity(id: string): EntitySpec {
  return new EntitySpec({ id, role: id, persona: `${id} 作用域`, model: null });
}

/** fake turn：按作用域剧本逐轮吐载荷（payload 原样含保留键），捕获调用上下文。 */
class ScriptedTurn {
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
  id: 'b-task', kind: 'task', owner: 'main', content: '季度任务', seq: 0,
};
const OPINION_A: WhiteboardBlock = {
  id: 'b-op-a', kind: 'opinion', owner: 'collab_a', content: 'A的私密意见', seq: 1,
};
const OPINION_B: WhiteboardBlock = {
  id: 'b-op-b', kind: 'opinion', owner: 'collab_b', content: 'B的私密意见', seq: 2,
};

function blindSession(): WhiteboardSession {
  return {
    grants: default_whiteboard_grants('blind', ['collab_a', 'collab_b']),
    blocks: [TASK_BLOCK, OPINION_A, OPINION_B],
  };
}

const SHARE_TO_A = {
  kind: 'amend' as const,
  changes: [{ scope: 'collab_a', kind: 'opinion' as const, access: 'read' as const, op: 'grant' as const }],
  reason: '圆桌升级：放开 A 的意见互读',
};

function deps(
  turn: ScriptedTurn,
  extra: Partial<ExecutionRuntimeDeps> = {},
): ExecutionRuntimeDeps {
  const scopes = new Map<string, EntitySpec>(
    ['main', 'collab_a', 'collab_b'].map((id) => [id, entity(id)]),
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

function turnInputOf(turn: ScriptedTurn, scopeId: string): string {
  return turn.calls.filter((c) => c.scope.id === scopeId)[0]!.input;
}

describe('main __amend 经仲裁生效：子执行视图即时放大', () => {
  it('blind 板 main 声明 grant 互读 → collab_a input 见 B 意见；amendment 审计双路到达；产物无残留', async () => {
    const sink: WhiteboardAuditEntry[] = [];
    const turn = new ScriptedTurn({
      main: [
        { __amend: SHARE_TO_A, __next: { kind: 'scope', target: 'collab_a' } },
        { message: '裁决收尾' },
      ],
      collab_a: [{ opinion: 'A 回传' }],
    });
    const runtime = new ExecutionRuntime(
      deps(turn, { on_whiteboard_audit: (entries) => sink.push(...entries) }),
    );
    const result = await runtime.run({ task: '圆桌升级', whiteboard: blindSession() });
    expect(result.root.outcome).toBe('success');
    expect(turnInputOf(turn, 'collab_a')).toContain('B的私密意见');

    const amendEvents = result.events.filter(
      (e) => e.action === 'whiteboard_audit' && e.detail?.['kind'] === 'amendment',
    );
    expect(amendEvents).toHaveLength(1);
    expect(amendEvents[0]!.detail?.['scope']).toBe('main');
    expect(amendEvents[0]!.detail?.['action']).toBe('write');
    expect(amendEvents[0]!.detail?.['amendment']).toEqual({
      changes: SHARE_TO_A.changes,
      reason: SHARE_TO_A.reason,
    });
    expect(sink.filter((e) => e.kind === 'amendment')).toHaveLength(1);
    expect(result.final_product).not.toHaveProperty('__amend');
  });
});

describe('非仲裁者声明 __amend：fail-closed 不生效', () => {
  it('collab_a 的改授权声明被拒（子 run 失败上浮摘要），板授权零变化', async () => {
    const turn = new ScriptedTurn({
      main: [{ __next: { kind: 'scope', target: 'collab_a' } }, { message: '收尾' }],
      collab_a: [{ __amend: { ...SHARE_TO_A, reason: 'A 越权自扩读权限' } }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({ task: '协作', whiteboard: blindSession() });
    const child = result.runs.find((r) => r.entry_scope === 'collab_a')!;
    expect(child.outcome).toBe('failure');
    expect(child.error).toContain('仲裁');
    expect(result.root.outcome).toBe('degraded');
    // 授权零变化：B 意见仍不可见于其后的 A 视图（main 二轮视图也无变化痕迹）
    expect(result.events.some((e) => e.detail?.['kind'] === 'amendment')).toBe(false);
  });

  it('声明结构非法（kind≠amend）→ 本 run 显式拒绝判失败', async () => {
    const turn = new ScriptedTurn({
      main: [{ __amend: { kind: 'route', changes: SHARE_TO_A.changes, reason: 'r' } }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({ task: '坏声明', whiteboard: blindSession() });
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('__amend');
  });
});

describe('零漂移：无白板 run 的 __amend 被静默消费', () => {
  it('无白板键不抛错、不发审计事件、不残留产物', async () => {
    const turn = new ScriptedTurn({
      main: [{ __amend: SHARE_TO_A, message: '普通直答' }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({ task: '无白板' });
    expect(result.root.outcome).toBe('success');
    expect(result.final_product['message']).toBe('普通直答');
    expect(result.final_product).not.toHaveProperty('__amend');
    expect(result.events.some((e) => e.action === 'whiteboard_audit')).toBe(false);
  });
});
