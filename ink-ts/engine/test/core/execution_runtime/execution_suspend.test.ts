// gate: 超限(382 行) - 挂起/恢复/注入中文头注单测聚合（场景多、头注详尽，拆分会伤可读性）
/**
 * 执行级挂起/恢复测试（W7-D：执行循环审批挂卡 + checkpoint 续跑 + 中断注入）。
 *
 * 测什么：
 * - 通道审批挂起：review 档 seam 返回 pending → run 结果 pending_approval +
 *   挂起卡（key/payload）+ root 链尾恢复锚点；不 fail-closed 阻断；
 * - 审批 resolve 续跑：resume_from + resume_inject accept → 从 checkpoint 恢复，
 *   已完成 turn 不重跑（turn 调用序 = main/subagent/main）；reject → 转场阻断
 *   收口 failure（fail-closed 方向）；
 * - 工具审批挂起（turn.interrupt）：挂起卡透出，恢复时注入决议经 ctx.inject
 *   重跑整轮（重入注入生效）；
 * - 子执行挂起恢复：已完成子链按终态回执（绝不重跑），中断子链快照续跑；
 * - §7.3 注入：next_user_input 文本并入下一 turn 输入（main 消费）；
 * - §7.3 中止改用：abort_requested 命中 → 本 run fail-closed 收口；
 * - checkpoint 链可 recovery：直答 run 链形态（turn_done → settled 终态），
 *   链校验零违规；跨 run 恢复锚点拒绝（线程校验）。
 */
import { describe, expect, it } from 'vitest';

import { ChannelDirectory, default_channel_seeds } from '../../../src/model/channels/channel_directory.js';
import { ChannelSpec } from '../../../src/model/channels/channel_spec.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { ExecutionRuntime } from '../../../src/core/execution_runtime/execution_runtime.js';
import type {
  ExecutionResult,
  ExecutionRuntimeDeps,
  ScopeTurnContext,
  ScopeTurnResult,
} from '../../../src/core/execution_runtime/runtime_types.js';
import { exec_checkpoint_thread } from '../../../src/core/execution_runtime/run_checkpoint.js';
import { InterruptState } from '../../../src/kernel/interrupt/interrupt_types.js';
import { validate_chain } from '../../../src/core/storage/storage.js';
import { MemoryStorage } from '../../kernel/executor/helpers.js';

function entity(id: string, persona: string): EntitySpec {
  return new EntitySpec({ id, role: id, persona, model: null });
}

type ScriptItem = Record<string, unknown> | { fail: true; reason: string } | { interrupt: { key: string; payload: Record<string, unknown> } };

/** fake turn：按 run_id×作用域剧本逐轮吐载荷/失败/中断；记录调用与注入。 */
class FakeTurn {
  readonly calls: Array<{ runId: string; scopeId: string; step: number; input: string; inject: Record<string, unknown> | null }> = [];
  constructor(private script: Record<string, ScriptItem[]>) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    this.calls.push({
      runId: ctx.run_id,
      scopeId: ctx.scope.id,
      step: ctx.step,
      input: ctx.input,
      inject: ctx.inject ?? null,
    });
    const key = `${ctx.run_id}:${ctx.scope.id}`;
    const item = this.script[key]?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { message: '（缺省直答）' } };
    if ('fail' in item) {
      const reason = item.reason as string;
      return { ok: false, reply: '', reason, summary: `${ctx.scope.id} ${reason}` };
    }
    if ('interrupt' in item) {
      const int = item.interrupt as { key: string; payload: Record<string, unknown> };
      return { ok: true, reply: '', interrupt: new InterruptState(int.key, int.payload) };
    }
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

function default_channels(): ChannelDirectory {
  const d = new ChannelDirectory();
  for (const spec of default_channel_seeds()) d.register(spec);
  return d;
}

function deps(
  script: Record<string, ScriptItem[]>,
  storage: MemoryStorage | null,
  extra: Partial<ExecutionRuntimeDeps> = {},
): { deps: ExecutionRuntimeDeps; turn: FakeTurn } {
  const scopes = new Map<string, EntitySpec>();
  for (const key of Object.keys(script)) {
    const scopeId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    if (scopeId === 'main' || scopeId === 'subagent' || scopeId === 'collaborator' || scopeId === 'planner') {
      scopes.set(scopeId, entity(scopeId, `${scopeId} 作用域`));
    }
  }
  scopes.set('main', entity('main', '主持人'));
  scopes.set('subagent', entity('subagent', '子代理'));
  scopes.set('collaborator', entity('collaborator', '协作者'));
  const turn = new FakeTurn(script);
  return {
    deps: {
      load_scope: (id) => scopes.get(id) ?? null,
      channels: default_channels(),
      turn,
      approval: async (): Promise<'accept' | 'auto' | 'reject' | 'pending'> => 'accept',
      storage,
      ...extra,
    },
    turn,
  };
}

function guardedChannels(): ChannelDirectory {
  const d = default_channels();
  d.register(new ChannelSpec({ id: 'guarded', shape: 'delegate', conditions: { approval: 'L2' } }));
  return d;
}

describe('通道审批挂起（review 档不阻断，产出挂起卡 + 恢复锚点）', () => {
  it('seam 返回 pending → pending_approval + 挂起卡 + checkpoint 锚点；accept 续跑完成', async () => {
    const storage = new MemoryStorage();
    const runId = 'exec_suspend_1';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [
        { __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } },
        { message: '收口' },
      ],
      [`${runId}:subagent`]: [{ answer: '子代理结果' }],
    };
    const { deps: d, turn } = deps(script, storage, {
      channels: guardedChannels(),
      approval: async (): Promise<'accept' | 'auto' | 'reject' | 'pending'> => 'pending',
    });
    const runtime = new ExecutionRuntime(d);
    const first = await runtime.run({ task: '委托吧', run_id: runId });
    expect(first.pending_approval).toBe(true);
    expect(first.pending_interrupt?.key).toBe('gate:channel:guarded');
    expect(first.pending_interrupt?.payload['level']).toBe('L2');
    expect(first.resume_checkpoint_id).toBeGreaterThan(0);
    // 挂起前只跑了 main 首轮
    expect(turn.calls.map((c) => c.scopeId)).toEqual(['main']);
    // 挂起卡随 checkpoint 持久化（可查）
    const cp = await storage.get_checkpoint(first.resume_checkpoint_id!);
    expect(cp?.reason).toBe('interrupted');
    expect(cp?.interrupt?.key).toBe('gate:channel:guarded');

    // 决议 accept → 从 checkpoint 恢复续跑
    const second = await runtime.run({
      task: '委托吧',
      run_id: runId,
      resume_from: first.resume_checkpoint_id!,
      resume_inject: { 'gate:channel:guarded': 'accept' },
    });
    expect(second.pending_approval).toBe(false);
    expect(second.blocked).toBe(false);
    expect(second.root.outcome).toBe('success');
    expect(second.final_product['message']).toBe('收口');
    // main 首轮不重跑：调用序 = main / subagent / main（第二轮）
    expect(turn.calls.map((c) => c.scopeId)).toEqual(['main', 'subagent', 'main']);
    expect(second.events.some((e) => e.action === 'run_resumed')).toBe(true);
  });

  it('reject 决议 → 转场阻断收口 failure（fail-closed 方向）', async () => {
    const storage = new MemoryStorage();
    const runId = 'exec_suspend_reject';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [{ __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } }],
    };
    const { deps: d } = deps(script, storage, {
      channels: guardedChannels(),
      approval: async (): Promise<'accept' | 'auto' | 'reject' | 'pending'> => 'pending',
    });
    const runtime = new ExecutionRuntime(d);
    const first = await runtime.run({ task: '委托吧', run_id: runId });
    expect(first.pending_approval).toBe(true);
    const second = await runtime.run({
      task: '委托吧',
      run_id: runId,
      resume_from: first.resume_checkpoint_id!,
      resume_inject: { 'gate:channel:guarded': 'reject' },
    });
    expect(second.pending_approval).toBe(false);
    expect(second.root.outcome).toBe('failure');
    expect(second.root.error).toContain('审批档 L2 未通过');
  });
});

describe('工具审批挂起（turn.interrupt 透出 + 注入重跑整轮）', () => {
  it('挂起卡透出；恢复注入经 ctx.inject 由模型回路消费', async () => {
    const storage = new MemoryStorage();
    const runId = 'exec_suspend_tool';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [
        { interrupt: { key: 'gate:web_search', payload: { tool: 'web_search' } } },
        { message: '注入后完成' },
      ],
    };
    const { deps: d, turn } = deps(script, storage);
    const runtime = new ExecutionRuntime(d);
    const first = await runtime.run({ task: '搜一下', run_id: runId });
    expect(first.pending_approval).toBe(true);
    expect(first.pending_interrupt?.key).toBe('gate:web_search');
    expect(turn.calls.length).toBe(1);
    // 首轮无注入
    expect(turn.calls[0]!.inject).toBeNull();

    const second = await runtime.run({
      task: '搜一下',
      run_id: runId,
      resume_from: first.resume_checkpoint_id!,
      resume_inject: { 'gate:web_search': 'accept' },
    });
    expect(second.pending_approval).toBe(false);
    expect(second.root.outcome).toBe('success');
    // 重入轮次带注入（整轮重跑）
    const replayed = turn.calls[1]!;
    expect(replayed.scopeId).toBe('main');
    expect(replayed.inject).toEqual({ 'gate:web_search': 'accept' });
    // 重跑轮步号与首轮一致（turn_resume 相位步进回拨，不产生步号空洞）
    expect(replayed.step).toBe(turn.calls[0]!.step);
    expect(second.final_product['message']).toBe('注入后完成');
  });
});

describe('子执行挂起恢复（已完成子链不重跑，中断子链快照续跑）', () => {
  it('fan_out 两路：一路完成一路挂卡 → 恢复后已完成路零重跑', async () => {
    const storage = new MemoryStorage();
    const rootId = 'exec_child_suspend';
    const script: Record<string, ScriptItem[]> = {
      [`${rootId}:main`]: [
        { __next: { kind: 'channel', channel: 'fan_out', target: 'collaborator', count: 2 } },
        { message: '双路裁决收口' },
      ],
      [`${rootId}.c0:collaborator`]: [{ opinion: '第一路完成' }],
      [`${rootId}.c1:collaborator`]: [
        { __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } },
      ],
      // c1 委托派生的子 run 命名 = <c1>.c0（delegate 1→1 的 index 0）
      [`${rootId}.c1.c0:subagent`]: [{ answer: '第二路子代理' }],
    };
    const { deps: d, turn } = deps(script, storage, {
      channels: guardedChannels(),
      approval: async (): Promise<'accept' | 'auto' | 'reject' | 'pending'> => 'pending',
    });
    const runtime = new ExecutionRuntime(d);
    const first = await runtime.run({ task: '并行委托', run_id: rootId });
    expect(first.pending_approval).toBe(true);
    // 挂起前：main 首轮 + c0 完成 + c1 首轮（挂卡前）
    const preScopes = turn.calls.map((c) => c.scopeId);
    expect(preScopes.includes('collaborator')).toBe(true);
    const c0PreCount = turn.calls.filter((c) => c.runId === `${rootId}.c0`).length;
    expect(c0PreCount).toBe(1);

    const second = await runtime.run({
      task: '并行委托',
      run_id: rootId,
      resume_from: first.resume_checkpoint_id!,
      resume_inject: { 'gate:channel:guarded': 'accept' },
    });
    expect(second.pending_approval).toBe(false);
    expect(second.root.outcome).toBe('success');
    expect(second.final_product['message']).toBe('双路裁决收口');
    // 已完成子执行 c0 绝不重跑（全程恰好 1 次）
    const c0Total = turn.calls.filter((c) => c.runId === `${rootId}.c0`).length;
    expect(c0Total).toBe(1);
    // c1 中断子链快照续跑：c1 首轮（step=1）不重跑（turn_done 相位跳过）；
    // 子代理新派生（c1.c0）；c1 第二轮是归并后循环续跑的新 turn
    const c1First = turn.calls.filter((c) => c.runId === `${rootId}.c1` && c.step === 1).length;
    expect(c1First).toBe(1);
    expect(turn.calls.some((c) => c.scopeId === 'subagent')).toBe(true);
    expect(second.final_product['message']).toBe('双路裁决收口');
  });
});

describe('§7.3 中断注入（运行中用户发话）', () => {
  it('注入：用户上下文并入下一 turn 输入（main 消费）', async () => {
    const storage = new MemoryStorage();
    const runId = 'exec_inject';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [
        { __next: { kind: 'scope', target: 'subagent' } },
        { message: '按用户补充收口' },
      ],
      [`${runId}:subagent`]: [{ answer: '初步结果' }],
    };
    let injected = '改用方案 B';
    const { deps: d, turn } = deps(script, storage, {
      next_user_input: (id, scopeId) => (scopeId === 'main' ? injected : null),
    });
    const runtime = new ExecutionRuntime(d);
    const result = await runtime.run({ task: '原始任务', run_id: runId });
    expect(result.root.outcome).toBe('success');
    const mainTurns = turn.calls.filter((c) => c.scopeId === 'main');
    expect(mainTurns.length).toBe(2);
    // 第二轮 main 输入携带注入文本（并入 task 前缀 + 载荷投影）
    expect(mainTurns[1]!.input).toContain('改用方案 B');
    expect(result.events.some((e) => e.action === 'user_inject')).toBe(true);
    injected = '';
  });

  it('中止改用：abort_requested 命中 → 本 run fail-closed 收口', async () => {
    const storage = new MemoryStorage();
    const runId = 'exec_abort';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [{ message: '第一轮' }],
    };
    let aborted = false;
    const { deps: d } = deps(script, storage, {
      abort_requested: (id) => (id === runId ? aborted : false),
    });
    const runtime = new ExecutionRuntime(d);
    aborted = true;
    const result = await runtime.run({ task: '长任务', run_id: runId });
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('中止');
  });
});

describe('执行级 checkpoint 链（recovery 面）', () => {
  it('直答 run 链形态：turn_done + settled 终态，链校验零违规', async () => {
    const storage = new MemoryStorage();
    const runId = 'exec_chain_ok';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [{ message: '直答' }],
    };
    const { deps: d } = deps(script, storage);
    const runtime = new ExecutionRuntime(d);
    const result = await runtime.run({ task: '问一句', run_id: runId });
    expect(result.root.outcome).toBe('success');
    const thread = exec_checkpoint_thread(runId);
    const cps = await storage.list_checkpoints(thread);
    // turn_done + settled 两条
    expect(cps.length).toBe(2);
    expect(cps[0]!.reason).toBe('success');
    expect(cps[0]!.interrupt).toBeNull();
    const violations = await validate_chain(storage, thread);
    expect(violations).toEqual([]);
  });

  it('跨 run 恢复锚点拒绝（线程归属校验，防串链错位）', async () => {
    const storage = new MemoryStorage();
    const runIdA = 'exec_chain_a';
    const script: Record<string, ScriptItem[]> = {
      [`${runIdA}:main`]: [{ message: '直答' }],
    };
    const { deps: d } = deps(script, storage);
    const runtime = new ExecutionRuntime(d);
    const first = await runtime.run({ task: 'x', run_id: runIdA });
    expect(first.root.outcome).toBe('success');
    const cp = (await storage.list_checkpoints(exec_checkpoint_thread(runIdA)))[0]!;
    const wrong = await runtime.run({
      task: 'x',
      run_id: 'exec_chain_b',
      resume_from: cp.checkpoint_id,
      resume_inject: {},
    });
    expect(wrong.blocked).toBe(true);
    expect(wrong.block_reason).toContain('不属于执行 exec_chain_b');
  });

  it('settled 相位误续跑（已完成 run）→ 按相位回执收口，不重跑 turn、不重复 settle', async () => {
    const storage = new MemoryStorage();
    const runId = 'exec_chain_settled';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [{ message: '已完成' }],
    };
    const { deps: d, turn } = deps(script, storage);
    const runtime = new ExecutionRuntime(d);
    const first = await runtime.run({ task: 'x', run_id: runId });
    expect(first.root.outcome).toBe('success');
    const tail = (await storage.list_checkpoints(exec_checkpoint_thread(runId)))[0]!;
    expect(tail.reason).toBe('success');
    const callsBefore = turn.calls.length;
    const redo = await runtime.run({
      task: 'x',
      run_id: runId,
      resume_from: tail.checkpoint_id,
      resume_inject: {},
    });
    // 不重跑 turn；按 settled 回执原样收口
    expect(turn.calls.length).toBe(callsBefore);
    expect(redo.pending_approval).toBe(false);
    expect(redo.root.outcome).toBe('success');
    expect(redo.final_product['message']).toBe('已完成');
    // 链不因误续跑追加（无重复 settle checkpoint）
    const after = await storage.list_checkpoints(exec_checkpoint_thread(runId));
    expect(after.length).toBe(2);
  });
});
