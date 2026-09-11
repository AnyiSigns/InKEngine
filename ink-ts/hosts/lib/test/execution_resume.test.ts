/**
 * 执行挂起/恢复宿主接线测试（W7-D：HostExecutionService 审批挂卡 →
 * resumeExecution 续跑；运行中 inject 注入）。
 *
 * 测什么：
 * - review 卡挂起→resolve→出结论：review 姿态 + hang=true + storage 装配 →
 *   runExecution 返回 pending_approval + 挂起卡（key/payload）+ 恢复锚点；
 *   resumeExecution accept 决议 → 从 checkpoint 续跑 → 汇聚点结论；main 首轮
 *   不重跑（调用序 = main/subagent/main）；
 * - reject 决议 fail-closed：恢复后转场阻断收口 failure；
 * - 无 storage 时 review 档保持 fail-closed 阻断（宁拒勿挂死，孤儿卡防护）；
 * - 运行中 inject 生效（§7.3）：turn 1 在闸前阻塞时注入 → main 第二轮输入
 *   携带注入文本（排队至下一 main 轮消费）；
 * - 挂起卡随 checkpoint 持久化（恢复锚点读回 interrupt 键）。
 */
import { describe, expect, it } from 'vitest';

import {
  ChannelDirectory,
  ChannelSpec,
  EntitySpec,
  create_storage,
  default_channel_seeds,
} from '@ink-ts/engine';
import type { ScopeTurnContext, ScopeTurnResult } from '@ink-ts/engine';

import { HostExecutionService } from '../src/execution/service.js';

type ScriptItem = Record<string, unknown> | { fail: true; reason: string };

/** fake turn：按 run_id×作用域剧本逐轮吐载荷；可选 turn 闸（测试注入时序）。 */
class FakeTurn {
  readonly calls: Array<{ runId: string; scopeId: string; step: number; input: string }> = [];
  constructor(
    private script: Record<string, ScriptItem[]>,
    private gate: ((ctx: ScopeTurnContext) => Promise<void> | void) | null = null,
  ) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    this.calls.push({ runId: ctx.run_id, scopeId: ctx.scope.id, step: ctx.step, input: ctx.input });
    if (this.gate !== null) await this.gate(ctx);
    const key = `${ctx.run_id}:${ctx.scope.id}`;
    const item = this.script[key]?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { message: '（缺省直答）' } };
    if ('fail' in item) {
      const reason = item.reason as string;
      return { ok: false, reply: '', reason, summary: `${ctx.scope.id} ${reason}` };
    }
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

function scoped(id: string, persona = `${id} 作用域`): EntitySpec {
  return new EntitySpec({ id, role: id, persona, model: null });
}

function guardedChannels(): ChannelDirectory {
  const d = new ChannelDirectory();
  for (const seed of default_channel_seeds()) d.register(seed);
  d.register(new ChannelSpec({ id: 'guarded', shape: 'delegate', conditions: { approval: 'L2' } }));
  return d;
}

function service(
  script: Record<string, ScriptItem[]>,
  scopes: EntitySpec[],
  extra: Partial<ConstructorParameters<typeof HostExecutionService>[0]> = {},
  gate: ((ctx: ScopeTurnContext) => Promise<void> | void) | null = null,
): { service: HostExecutionService; turn: FakeTurn } {
  const turn = new FakeTurn(script, gate);
  const svc = new HostExecutionService({
    loadScope: ((id: string) => scopes.find((s) => s.id === id) ?? null) as never,
    turnOverride: turn as never,
    channels: guardedChannels(),
    ...extra,
  });
  return { service: svc, turn };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('review 卡挂起 → resumeExecution 续跑（出结论）', () => {
  it('pending 挂起卡 + 恢复锚点；accept 决议续跑完成，main 首轮不重跑', async () => {
    const storage = await create_storage('memory://');
    const runId = 'exec_resume_e2e';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [
        { __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } },
        { message: '汇总结论' },
      ],
      [`${runId}:subagent`]: [{ answer: '子代理结论' }],
    };
    const { service: svc, turn } = service(script, [scoped('main'), scoped('subagent')], {
      storage: () => storage,
    });
    const first = await svc.runExecution(
      { task: '委托并汇总结论', run_id: runId },
      { pose: 'review', hang: true },
    );
    expect(first.pending_approval).toBe(true);
    expect(first.pending_interrupt?.key).toBe('gate:channel:guarded');
    expect(first.pending_interrupt?.payload['level']).toBe('L2');
    expect(first.resume_checkpoint_id).toBeGreaterThan(0);
    expect(turn.calls.map((c) => c.scopeId)).toEqual(['main']);
    // 挂起卡随 checkpoint 持久化（恢复锚点可读回 interrupt 键）
    const anchor = await storage.get_checkpoint(first.resume_checkpoint_id!);
    expect(anchor?.reason).toBe('interrupted');
    expect(anchor?.interrupt?.key).toBe('gate:channel:guarded');

    const second = await svc.resumeExecution(runId, first.resume_checkpoint_id!, 'accept');
    expect(second.pending_approval).toBe(false);
    expect(second.blocked).toBe(false);
    expect(second.root.outcome).toBe('success');
    expect(second.final_product['message']).toBe('汇总结论');
    // main 首轮不重跑：调用序 = main / subagent / main（第二轮收口）
    expect(turn.calls.map((c) => c.scopeId)).toEqual(['main', 'subagent', 'main']);
    expect(second.events.some((e) => e.action === 'run_resumed')).toBe(true);
  });

  it('reject 决议 → 转场阻断收口 failure（fail-closed 方向）', async () => {
    const storage = await create_storage('memory://');
    const runId = 'exec_resume_reject';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [{ __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } }],
    };
    const { service: svc } = service(script, [scoped('main'), scoped('subagent')], { storage: () => storage });
    const first = await svc.runExecution(
      { task: '委托', run_id: runId },
      { pose: 'review', hang: true },
    );
    expect(first.pending_approval).toBe(true);
    const second = await svc.resumeExecution(runId, first.resume_checkpoint_id!, 'reject');
    expect(second.pending_approval).toBe(false);
    expect(second.root.outcome).toBe('failure');
    expect(second.root.error).toContain('审批档 L2 未通过');
  });

  it('无 storage 时 review 档保持 fail-closed 阻断（孤儿卡防护：挂起无续跑能力 = 拒）', async () => {
    const runId = 'exec_resume_nostorage';
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [{ __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } }],
    };
    const { service: svc } = service(script, [scoped('main'), scoped('subagent')]);
    const result = await svc.runExecution({ task: '委托', run_id: runId }, { pose: 'review', hang: true });
    expect(result.pending_approval).toBe(false);
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('审批档 L2 未通过');
  });
});

describe('§7.3 运行中注入（injectUserInput → 下一 main 轮消费）', () => {
  it('turn 1 在闸前阻塞时注入 → main 第二轮输入携带注入文本', async () => {
    const storage = await create_storage('memory://');
    const runId = 'exec_inject_host';
    let releaseT1: () => void = () => {};
    const t1Gate = new Promise<void>((r) => {
      releaseT1 = r;
    });
    const script: Record<string, ScriptItem[]> = {
      [`${runId}:main`]: [
        { __next: { kind: 'scope', target: 'subagent' } },
        { message: '按补充收口' },
      ],
      [`${runId}:subagent`]: [{ answer: '初步结果' }],
    };
    const { service: svc, turn } = service(
      script,
      [scoped('main'), scoped('subagent')],
      { storage: () => storage },
      async (ctx) => {
        if (ctx.run_id === runId && ctx.scope.id === 'main' && ctx.step === 1) await t1Gate;
      },
    );
    const runPromise = svc.runExecution({ task: '原始任务', run_id: runId }, {});
    // 等 main 首轮真正开跑（seam 已询问、turn 1 在闸前阻塞）后注入
    await waitFor(() => turn.calls.length >= 1);
    svc.injectUserInput(runId, '用户补充：改用方案 B');
    releaseT1();
    const result = await runPromise;
    expect(result.root.outcome).toBe('success');
    const mainTurns = turn.calls.filter((c) => c.scopeId === 'main');
    expect(mainTurns.length).toBe(2);
    // main 第二轮输入并入注入文本（排队至下一 main 轮消费）
    expect(mainTurns[1]!.input).toContain('用户补充：改用方案 B');
    expect(result.events.some((e) => e.action === 'user_inject')).toBe(true);
  });
});
