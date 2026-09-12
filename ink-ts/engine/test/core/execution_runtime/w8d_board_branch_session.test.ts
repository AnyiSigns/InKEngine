// gate: 超限(385 行) - W8D 执行模型完备性收口单测聚合（__board 板面写路径/checkpoint 分叉/会话记忆注入三面，场景多、头注详尽，拆分会伤可读性）
/**
 * W8D 执行模型完备性收口测试：①圆桌共享板面写路径（`__board` 结构化产物）；
 * ②checkpoint 分叉（execution.branch：从既有执行 checkpoint 状态分叉新
 * run_id）；③会话记忆注入（session_context：宿主 history 摘要切片仅进 main
 * 作用域根 run turn）。
 *
 * 测什么：
 * - __board 授权写：open 模式协作者声明 {kind:'board',op:'append',content}
 *   → board 块追加（owner=声明作用域），write 审计经 whiteboard_audit 事件 +
 *   deps.on_whiteboard_audit 双路到达一次，后续作用域视图可见新块，产物无
 *   `__board` 残留（clean_payload 同口径）；
 * - __board 盲模式无授权：非协作者作用域声明 → 显式拒绝（理由含盲模式），
 *   子 run fail-closed 判失败，板面/审计零变化；
 * - __board 显式授权：盲模式召集 grants 显式授 board write → 生效（授权
 *   判定以 grants 条目为裁决源，不依赖召集 mode）；
 * - branch 分叉：从挂起 checkpoint（turn_done+gate pending）分叉新 run_id
 *   独立续跑（新 exec 链/新白板按新 run 开）→ 原 run 链不被触碰、可另行
 *   恢复续跑——两 run 载荷/结果互不污染；fork 回执 run_start 带 branch_from；
 * - branch fail-closed：resume_from 与 branch_from 互斥、run_id 与源 run
 *   相同、storage 缺位 = blocked 显式拒绝；
 * - session_context：仅 main 根 run turn 注入（输入含「会话记忆」标注段），
 *   子执行/子作用域零注入；不进 checkpoint（引擎不持久化记忆）；无与空串
 *   零漂移（输入逐字段一致）。
 */
import { describe, expect, it } from 'vitest';

import { ChannelDirectory, default_channel_seeds } from '../../../src/model/channels/channel_directory.js';
import { ChannelSpec } from '../../../src/model/channels/channel_spec.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { ExecutionRuntime } from '../../../src/core/execution_runtime/execution_runtime.js';
import type { ScopeTurnResult } from '../../../src/core/execution_runtime/scope_turn.js';
import type {
  ExecutionRuntimeDeps,
  ScopeTurnContext,
  WhiteboardSession,
} from '../../../src/core/execution_runtime/runtime_types.js';
import { exec_checkpoint_thread } from '../../../src/core/execution_runtime/run_checkpoint.js';
import { default_whiteboard_grants } from '../../../src/core/whiteboard/index.js';
import type { WhiteboardBlock } from '../../../src/core/whiteboard/index.js';
import { MemoryStorage } from '../../kernel/executor/helpers.js';

function entity(id: string): EntitySpec {
  return new EntitySpec({ id, role: id, persona: `${id} 作用域`, model: null });
}

type ScriptItem = Record<string, unknown> | { fail: true; reason: string };

/** fake turn：按 run_id×作用域剧本逐轮吐载荷（payload 原样含保留键），捕获调用上下文。 */
class ScriptedTurn {
  readonly calls: ScopeTurnContext[] = [];
  constructor(private script: Record<string, ScriptItem[]>) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    this.calls.push(ctx);
    const item = this.script[`${ctx.run_id}:${ctx.scope.id}`]?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { message: '（缺省直答）' } };
    if ('fail' in item) {
      const reason = item.reason as string;
      return { ok: false, reply: '', reason, summary: `${ctx.scope.id} ${reason}` };
    }
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

/** 某 run 的调用序（scopeId 序列；子 run 按各自 run_id 独立计）。 */
function scopeSeqOf(turn: ScriptedTurn, runId: string): string[] {
  return turn.calls.filter((c) => c.run_id === runId).map((c) => c.scope.id);
}

/** 某作用域的首次/指定轮输入（跨 run 检索——子执行是独立子 run）。 */
function inputOf(turn: ScriptedTurn, scopeId: string, step?: number): string {
  const hit = turn.calls.find((c) => c.scope.id === scopeId && (step === undefined || c.step === step));
  return hit?.input ?? '';
}

const TASK_BLOCK: WhiteboardBlock = {
  id: 'b-task', kind: 'task', owner: 'main', content: '季度任务', seq: 0,
};

function blindSession(collaborators: readonly string[]): WhiteboardSession {
  return { grants: default_whiteboard_grants('blind', collaborators), blocks: [TASK_BLOCK] };
}

function guardedChannels(): ChannelDirectory {
  const d = new ChannelDirectory();
  for (const spec of default_channel_seeds()) d.register(spec);
  d.register(new ChannelSpec({ id: 'guarded', shape: 'delegate', conditions: { approval: 'L2' } }));
  return d;
}

function deps(
  turn: ScriptedTurn,
  extra: Partial<ExecutionRuntimeDeps> = {},
): ExecutionRuntimeDeps {
  const scopes = new Map<string, EntitySpec>(
    ['main', 'collab_a', 'subagent'].map((id) => [id, entity(id)]),
  );
  const channels = new ChannelDirectory();
  for (const spec of default_channel_seeds()) channels.register(spec);
  return {
    load_scope: (id) => scopes.get(id) ?? null,
    channels,
    turn,
    approval: async (): Promise<'accept' | 'auto' | 'reject' | 'pending'> => 'accept',
    ...extra,
  };
}

const BOARD_DECL = {
  kind: 'board' as const,
  op: 'append' as const,
  content: '圆桌共享备忘：采用方案 B',
};

describe('__board 授权写：open 模式追加 board 块 + 审计双路到达', () => {
  it('main 声明 __board → 块追加（owner=main），协作者视图可见，审计事件一次；产物无残留', async () => {
    const sink: Array<{ scope: string; block_id: string; kind: string; action: string }> = [];
    const runId = 'wb_board_open';
    const turn = new ScriptedTurn({
      [`${runId}:main`]: [
        { __board: BOARD_DECL, __next: { kind: 'scope', target: 'collab_a' } },
        { message: '裁决收尾' },
      ],
      [`${runId}.c0:collab_a`]: [{ opinion: 'A 回传' }],
    });
    const runtime = new ExecutionRuntime(
      deps(turn, {
        on_whiteboard_audit: (entries) => sink.push(...entries),
      }),
    );
    const result = await runtime.run({
      task: '圆桌协作',
      run_id: runId,
      whiteboard: {
        grants: default_whiteboard_grants('open', ['collab_a']),
        blocks: [TASK_BLOCK],
      },
    });
    expect(result.root.outcome).toBe('success');
    expect(result.final_product['message']).toBe('裁决收尾');
    expect(result.final_product).not.toHaveProperty('__board');
    // 协作者 turn 视图含新 board 块（open 圆桌共享空间）
    expect(inputOf(turn, 'collab_a')).toContain('圆桌共享备忘：采用方案 B');
    // write 审计：事件带 + 宿主 sink 双路各一次（kind=board / action=write）
    const boardEvents = result.events.filter(
      (e) => e.action === 'whiteboard_audit' && e.detail?.['kind'] === 'board' && e.detail?.['action'] === 'write',
    );
    expect(boardEvents).toHaveLength(1);
    expect(boardEvents[0]!.detail?.['scope']).toBe('main');
    expect(boardEvents[0]!.detail?.['block_id']).toMatch(/^board-\d+$/);
    expect(sink.filter((e) => e.kind === 'board' && e.action === 'write')).toHaveLength(1);
  });

  it('盲模式召集 grants 显式授 board write → 非协作者作用域写板生效', async () => {
    const sink: Array<{ scope: string; block_id: string; kind: string; action: string }> = [];
    const runId = 'wb_board_grant';
    const turn = new ScriptedTurn({
      [`${runId}:main`]: [{ __next: { kind: 'scope', target: 'subagent' } }, { message: '收尾' }],
      [`${runId}.c0:subagent`]: [{ __board: BOARD_DECL, message: '子代理落板' }],
    });
    const runtime = new ExecutionRuntime(
      deps(turn, {
        on_whiteboard_audit: (entries) => sink.push(...entries),
      }),
    );
    const result = await runtime.run({
      task: '显式授权写板',
      run_id: runId,
      whiteboard: {
        grants: {
          mode: 'blind',
          entries: [{ scope: 'subagent', kind: 'board', access: 'write' }],
        },
        blocks: [TASK_BLOCK],
      },
    });
    expect(result.root.outcome).toBe('success');
    const child = result.runs.find((r) => r.entry_scope === 'subagent')!;
    expect(child.outcome).toBe('success');
    // 生效审计 scope=subagent；main 主持人全可见其后视图
    expect(sink.some((e) => e.kind === 'board' && e.action === 'write' && e.scope === 'subagent')).toBe(true);
    expect(inputOf(turn, 'main', 2)).toContain('圆桌共享备忘：采用方案 B');
  });
});

describe('__board 盲模式无授权：显式拒绝 fail-closed', () => {
  it('非协作者作用域声明 __board → 子 run 判失败（理由含盲模式），板面/审计零变化', async () => {
    const runId = 'wb_board_blind';
    const turn = new ScriptedTurn({
      [`${runId}:main`]: [{ __next: { kind: 'scope', target: 'subagent' } }, { message: '收尾' }],
      [`${runId}.c0:subagent`]: [{ __board: BOARD_DECL, message: '越权落板' }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({ task: '盲板协作', run_id: runId, whiteboard: blindSession(['collab_a']) });
    const child = result.runs.find((r) => r.entry_scope === 'subagent')!;
    expect(child.outcome).toBe('failure');
    expect(child.error).toContain('盲模式');
    expect(result.root.outcome).toBe('degraded');
    // 板面零变化：无 board write 审计
    expect(result.events.some((e) => e.detail?.['kind'] === 'board' && e.detail?.['action'] === 'write')).toBe(false);
  });

  it('声明结构非法（op≠append/缺 content）→ 本 run 显式拒绝判失败', async () => {
    const runId = 'wb_board_bad';
    const turn = new ScriptedTurn({
      [`${runId}:main`]: [{ __board: { kind: 'board', op: 'overwrite', content: 'x' } }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({ task: '坏声明', run_id: runId, whiteboard: blindSession(['collab_a']) });
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('__board');
  });

  it('零漂移：无白板 run 的 __board 被静默消费（不抛错、不发审计、不残留）', async () => {
    const runId = 'wb_board_none';
    const turn = new ScriptedTurn({
      [`${runId}:main`]: [{ __board: BOARD_DECL, message: '普通直答' }],
    });
    const runtime = new ExecutionRuntime(deps(turn));
    const result = await runtime.run({ task: '无白板', run_id: runId });
    expect(result.root.outcome).toBe('success');
    expect(result.final_product['message']).toBe('普通直答');
    expect(result.final_product).not.toHaveProperty('__board');
    expect(result.events.some((e) => e.action === 'whiteboard_audit')).toBe(false);
  });
});

describe('branch 分叉：从挂起 checkpoint 分叉新 run 独立续跑', () => {
  it('fork 续跑成功 + 原 run 链零触碰、可另行恢复；两 run 互不污染', async () => {
    const storage = new MemoryStorage();
    const runA = 'w8d_branch_a';
    const forkId = 'w8d_branch_fork';
    // 原 run：main 首轮声明走 guarded 通道 → 审批 pending 挂起
    const turnA = new ScriptedTurn({
      [`${runA}:main`]: [{ __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } }, { message: 'A 收口' }],
      [`${runA}.c0:subagent`]: [{ answer: 'A 子结果' }],
    });
    const runtimeA = new ExecutionRuntime(
      deps(turnA, {
        channels: guardedChannels(),
        approval: async (): Promise<'accept' | 'auto' | 'reject' | 'pending'> => 'pending',
        storage,
      }),
    );
    const first = await runtimeA.run({
      task: 'A 委托',
      run_id: runA,
      whiteboard: blindSession(['collab_a']),
    });
    expect(first.pending_approval).toBe(true);
    expect(first.resume_checkpoint_id).toBeGreaterThan(0);
    expect(scopeSeqOf(turnA, runA)).toEqual(['main']);

    // fork：新 runtime（approval accept = 新 run 独立审批生命周期）+ 新 run_id；
    // 从挂起锚点 checkpoint 分叉——复用恢复解析重建状态，白板按新 run 开（无注入 = 空）
    const turnFork = new ScriptedTurn({
      [`${forkId}:main`]: [{ message: 'FORK 收口' }],
      [`${forkId}.c0:subagent`]: [{ answer: 'FORK 子结果' }],
    });
    const runtimeFork = new ExecutionRuntime(
      deps(turnFork, {
        channels: guardedChannels(),
        storage,
      }),
    );
    const fork = await runtimeFork.run({
      run_id: forkId,
      branch_from: { source_run_id: runA, checkpoint_id: first.resume_checkpoint_id! },
    });
    expect(fork.blocked).toBe(false);
    expect(fork.pending_approval).toBe(false);
    expect(fork.root.outcome).toBe('success');
    expect(fork.final_product['message']).toBe('FORK 收口');
    // fork 续跑不重跑 main 首轮：调用序 = 子代理 / main 收口（子 run 独立 run_id，
    // 故按全部调用的作用域序列断言）
    expect(turnFork.calls.map((c) => c.scope.id)).toEqual(['subagent', 'main']);
    // fork 白板按新 run 开：无注入白板 → 视图不含源 run 的任务块内容
    expect(inputOf(turnFork, 'main', 2)).not.toContain('季度任务');
    // run_start 事件带 branch_from 留痕（决策留痕）
    const startEvent = fork.events.find((e) => e.action === 'run_start')!;
    expect(startEvent.detail?.['branch_from']).toEqual({
      source_run_id: runA,
      checkpoint_id: first.resume_checkpoint_id,
    });

    // 互不污染①：fork 落自己的 exec 链（settled），原 run 链尾仍是挂起卡（零触碰）
    const forkTail = await storage.get_latest_checkpoint(exec_checkpoint_thread(forkId));
    expect(forkTail?.reason).toBe('success');
    const aTailAfterFork = await storage.get_latest_checkpoint(exec_checkpoint_thread(runA));
    expect(aTailAfterFork?.reason).toBe('interrupted');
    expect(aTailAfterFork?.checkpoint_id).toBe(first.resume_checkpoint_id);

    // 互不污染②：原 run 另行恢复续跑成功（其脚本/载荷独立演进）
    const resumed = await runtimeA.run({
      run_id: runA,
      resume_from: first.resume_checkpoint_id!,
      resume_inject: { 'gate:channel:guarded': 'accept' },
    });
    expect(resumed.root.outcome).toBe('success');
    expect(resumed.final_product['message']).toBe('A 收口');
    expect(turnA.calls.map((c) => c.scope.id)).toEqual(['main', 'subagent', 'main']);
    const aTailAfterResume = await storage.get_latest_checkpoint(exec_checkpoint_thread(runA));
    expect(aTailAfterResume?.reason).toBe('success');
    // fork 与 A 的产物各自独立（载荷深拷贝隔离）
    expect(fork.final_product['message']).toBe('FORK 收口');
    expect(resumed.final_product['message']).toBe('A 收口');
  });

  it('fail-closed：与 resume_from 互斥 / run_id 与源相同 / 缺 storage → blocked 显式拒绝', async () => {
    const storage = new MemoryStorage();
    const runA = 'w8d_branch_b';
    const turnA = new ScriptedTurn({
      [`${runA}:main`]: [{ __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } }],
    });
    const runtimeA = new ExecutionRuntime(
      deps(turnA, {
        channels: guardedChannels(),
        approval: async (): Promise<'accept' | 'auto' | 'reject' | 'pending'> => 'pending',
        storage,
      }),
    );
    const first = await runtimeA.run({ task: '挂起', run_id: runA });
    expect(first.pending_approval).toBe(true);

    const runFork = new ExecutionRuntime(deps(new ScriptedTurn({}), { channels: guardedChannels(), storage }));
    const sameRun = await runFork.run({
      run_id: runA,
      branch_from: { source_run_id: runA, checkpoint_id: first.resume_checkpoint_id! },
    });
    expect(sameRun.blocked).toBe(true);
    expect(sameRun.block_reason).toContain('不得与源 run 相同');

    const exclusive = await runFork.run({
      run_id: 'w8d_branch_c',
      resume_from: first.resume_checkpoint_id!,
      branch_from: { source_run_id: runA, checkpoint_id: first.resume_checkpoint_id! },
    });
    expect(exclusive.blocked).toBe(true);
    expect(exclusive.block_reason).toContain('互斥');

    const noStorage = await new ExecutionRuntime(
      deps(new ScriptedTurn({}), { channels: guardedChannels() }),
    ).run({
      run_id: 'w8d_branch_d',
      branch_from: { source_run_id: runA, checkpoint_id: first.resume_checkpoint_id! },
    });
    expect(noStorage.blocked).toBe(true);
    expect(noStorage.block_reason).toContain('storage');
  });
});

describe('session_context：仅 main 根 run turn 注入，不进子执行/checkpoint', () => {
  it('main 两轮输入携带标注段；子代理零注入；checkpoint 不持久化记忆', async () => {
    const storage = new MemoryStorage();
    const runId = 'w8d_session_1';
    const digest = 'user: 一问\nassistant: 一答';
    const turn = new ScriptedTurn({
      [`${runId}:main`]: [{ __next: { kind: 'scope', target: 'subagent' } }, { message: '收口' }],
      [`${runId}.c0:subagent`]: [{ answer: '子结果' }],
    });
    const runtime = new ExecutionRuntime(deps(turn, { storage }));
    const result = await runtime.run({ task: '会话续问', run_id: runId, session_context: digest });
    expect(result.root.outcome).toBe('success');
    const mainInputs = turn.calls.filter((c) => c.run_id === runId && c.scope.id === 'main');
    expect(mainInputs.length).toBe(2);
    for (const mt of mainInputs) {
      expect(mt.input).toContain('## 会话记忆');
      expect(mt.input).toContain('user: 一问');
    }
    // 子执行零注入：子代理输入只有载荷投影（任务文本），无记忆标注段
    const subInput = inputOf(turn, 'subagent');
    expect(subInput).not.toContain('会话记忆');
    expect(subInput).not.toContain('一问');
    // 引擎不持久化记忆：checkpoint 全链不含记忆文本
    const tail = await storage.get_latest_checkpoint(exec_checkpoint_thread(runId));
    expect(tail).not.toBeNull();
    expect(JSON.stringify(tail!.state)).not.toContain('一问');
  });

  it('零漂移：无 session_context 与空串输入逐字段一致', async () => {
    const runId = 'w8d_session_2';
    const turn1 = new ScriptedTurn({
      [`${runId}:main`]: [{ __next: { kind: 'scope', target: 'subagent' } }, { message: '收口' }],
      [`${runId}.c0:subagent`]: [{ answer: '子' }],
    });
    const turn2 = new ScriptedTurn({
      [`${runId}:main`]: [{ __next: { kind: 'scope', target: 'subagent' } }, { message: '收口' }],
      [`${runId}.c0:subagent`]: [{ answer: '子' }],
    });
    const run1 = new ExecutionRuntime(deps(turn1));
    const run2 = new ExecutionRuntime(deps(turn2));
    const a = await run1.run({ task: '无记忆', run_id: runId });
    const b = await run2.run({ task: '无记忆', run_id: runId, session_context: '' });
    expect(a.root.outcome).toBe('success');
    expect(b.root.outcome).toBe('success');
    expect(turn2.calls.map((c) => `${c.run_id}:${c.scope.id}#${c.step}`)).toEqual(
      turn1.calls.map((c) => `${c.run_id}:${c.scope.id}#${c.step}`),
    );
    expect(b.final_product).toEqual(a.final_product);
  });
});
