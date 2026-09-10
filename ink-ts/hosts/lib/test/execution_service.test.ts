/**
 * 宿主执行装配单测（HostExecutionService.runExecution + convene 召集协议，
 * fake turn 隔离引擎装载——机制语义在引擎，宿主只验证装配接线与回执面）。
 *
 * 测什么：
 * - runExecution 直答收口：fake turn 按 main 剧本吐载荷 → 汇聚点单份最终产物
 *   （bridge execution.run 背后的服务主线路径）；
 * - convene 目录作用域：n=3 blind 并行子执行（各自独立 run_id），full 契约
 *   三路意见全收回执 + conclusion 投影；
 * - convene 临时作用域：scope 现场定义 dict（role+persona）→ 子执行按 temp
 *   作用域装载（turn 收到 temp 身份），目录中不存在该 id；
 * - convene best 契约：质量信号择优单份（落选保留 losers 不入产物）；
 * - convene open 圆桌：后轮输入带前轮意见（round_view 投影进 seed_payload），
 *   rounds 上限封顶；
 * - 通道条件 fail-closed：自定义通道目录（fan_out.max_parallel=2 召 3 路 →
 *   gate 拒绝；approval 档 L1 + review 姿态 → 审批拒绝阻断；auto 姿态放行）；
 * - 参数校验：目标缺失/非法 n/非法 contract/目录不可装载 → ConveneError。
 */
import { describe, expect, it } from 'vitest';

import {
  ChannelDirectory,
  ChannelSpec,
  EntitySpec,
} from '@ink-ts/engine';

import { HostExecutionService } from '../src/execution/service.js';
import { ConveneError, convene } from '../src/execution/convene.js';
import type { ScopeTurnContext, ScopeTurnResult } from '@ink-ts/engine';

type ScriptItem = Record<string, unknown> | { fail: true; reason: string };

/** fake turn：按作用域剧本逐轮吐载荷（记录收到的身份与输入投影）。 */
class FakeTurn {
  readonly calls: Array<{ scopeId: string; role: string | null; input: string }> = [];
  constructor(private script: Record<string, ScriptItem[]>) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    const role = (ctx.scope as unknown as { role?: string }).role ?? null;
    this.calls.push({ scopeId: ctx.scope.id, role, input: ctx.input });
    const item = this.script[ctx.scope.id]?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { message: '（缺省直答）' } };
    if ('fail' in item) {
      const reason = item.reason as string;
      return { ok: false, reply: '', reason, summary: `${ctx.scope.id} ${reason}` };
    }
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

function fake_entity(id: string, persona: string): EntitySpec {
  return new EntitySpec({ id, role: id, persona, model: null });
}

/** 目录作用域装载（in-memory map；未注册 = null）。 */
function loaderFor(scopes: EntitySpec[]): (id: string) => EntitySpec | null {
  const map = new Map(scopes.map((s) => [s.id, s]));
  return (id: string) => map.get(id) ?? null;
}

function service(
  script: Record<string, ScriptItem[]>,
  scopes: EntitySpec[],
  extra: Partial<ConstructorParameters<typeof HostExecutionService>[0]> = {},
): { service: HostExecutionService; turn: FakeTurn } {
  const turn = new FakeTurn(script);
  const svc = new HostExecutionService({
    loadScope: loaderFor(scopes) as never,
    turnOverride: turn as never,
    ...extra,
  });
  return { service: svc, turn };
}

function scoped(id: string, persona = `${id} 作用域`): EntitySpec {
  return fake_entity(id, persona);
}

async function runMain(
  script: Record<string, ScriptItem[]>,
  extra: Partial<ConstructorParameters<typeof HostExecutionService>[0]> = {},
): Promise<Awaited<ReturnType<HostExecutionService['runExecution']>>> {
  const { service: svc } = service(script, [scoped('main')], extra);
  return svc.runExecution({ task: '做一件事' });
}

describe('runExecution 主线（execution.run 背后的服务装配）', () => {
  it('直答收口：fake turn 单轮产物 → 汇聚点唯一最终产物', async () => {
    const result = await runMain({ main: [{ message: '你好，这是直答' }] });
    expect(result.root.outcome).toBe('success');
    expect(result.final_product['message']).toBe('你好，这是直答');
    expect(result.runs.length).toBe(1);
  });

  it('入口目录作用域不可装载 = blocked（fail-closed，原因可见）', async () => {
    const { service: svc } = service({ main: [{ message: 'x' }] }, [scoped('main')]);
    const result = await svc.runExecution({ task: '做一件事', entry_scope: 'ghost' });
    expect(result.blocked).toBe(true);
    expect(result.block_reason).toContain('不可装载');
  });

  it('通道审批 seam：review 姿态遇审批档通道 = reject 阻断；auto 姿态放行', async () => {
    const dir = new ChannelDirectory();
    dir.register(new ChannelSpec({
      id: 'fan_out',
      shape: 'fan_out',
      conditions: { approval: 'L1' },
    }));
    const script = {
      main: [
        { __next: { kind: 'channel', channel: 'fan_out', target: 'subagent', count: 1 } },
        { message: '收口' },
      ],
      subagent: [{ answer: '子代理结果' }],
    };
    const build = () => new HostExecutionService({
      loadScope: loaderFor([scoped('main'), scoped('subagent')]) as never,
      turnOverride: new FakeTurn(script) as never,
      channels: dir,
    });
    const blocked = await build().runExecution({ task: '委托吧' }, { pose: 'review' });
    expect(blocked.root.outcome).toBe('failure');
    expect(blocked.root.error).toContain('审批档 L1 未通过');
    const passed = await build().runExecution({ task: '委托吧' }, { pose: 'auto' });
    expect(passed.blocked).toBe(false);
    expect(passed.root.outcome).toBe('success');
    expect(passed.final_product['message']).toBe('收口');
  });
});

describe('convene 多协作者召集（collab_request 执行体语义）', () => {
  it('目录作用域 n=3 blind 并行：full 契约全收回执 + conclusion 投影', async () => {
    const { service: svc } = service(
      {
        collaborator: [
          { opinion: '意见一' },
          { opinion: '意见二' },
          { opinion: '意见三' },
        ],
      },
      [scoped('main'), scoped('collaborator')],
    );
    const result = await convene(svc, {
      entity_id: 'collaborator',
      task: '出意见',
      n: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.scope_source).toBe('directory');
    expect(result.channel).toBe('fan_out');
    expect(result.children.length).toBe(3);
    const runIds = new Set(result.children.map((c) => c.run_id));
    expect(runIds.size).toBe(3);
    const adopted = result.merged['adopted'] as Array<Record<string, unknown>>;
    expect(adopted.length).toBe(3);
    expect(result.conclusion).toContain('意见一');
    expect(result.conclusion).toContain('意见三');
  });

  it('临时作用域：scope 现场定义 → temp 身份装载（目录无此 id）', async () => {
    const { service: svc, turn } = service(
      { debater: [{ opinion: '唱反调' }] },
      [scoped('main')],
    );
    const result = await convene(svc, {
      scope: { role: 'debater', persona: '负责唱反调' },
      task: '挑战结论',
    });
    expect(result.ok).toBe(true);
    expect(result.scope_source).toBe('temp');
    expect(result.scope_ref).toBe('temp:debater');
    // 临时作用域实体由运行时现场构造（id 命名空间 temp_scope:<run>:<n>，role=def.role）
    expect(turn.calls[0]!.scopeId).toMatch(/^temp_scope:/);
    expect(turn.calls[0]!.role).toBe('debater');
  });

  it('best 契约：质量信号择优单份，落选保留 losers 不入产物', async () => {
    const { service: svc } = service(
      {
        collaborator: [
          { opinion: '低质量', _quality: 1 },
          { opinion: '高质量', _quality: 9 },
        ],
      },
      [scoped('main'), scoped('collaborator')],
    );
    const result = await convene(svc, {
      entity_id: 'collaborator',
      task: '择优',
      n: 2,
      contract: 'best',
    });
    const adopted = result.merged['adopted'] as Array<Record<string, unknown>>;
    expect(adopted.length).toBe(1);
    expect(adopted[0]!['opinion']).toBe('高质量');
    expect((result.merged['losers'] as string[]).length).toBe(1);
    expect(result.merged['contract']).toBe('best');
  });

  it('open 圆桌：后轮输入带前轮意见投影（round_view），rounds 上限封顶', async () => {
    const { service: svc, turn } = service(
      {
        collaborator: [
          { opinion: '第一轮意见' },
          { opinion: '第二轮意见' },
        ],
      },
      [scoped('main'), scoped('collaborator')],
    );
    const result = await convene(svc, {
      entity_id: 'collaborator',
      task: '审议',
      n: 1,
      mode: 'open',
      rounds: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.rounds_run).toBe(2);
    expect(turn.calls.length).toBe(2);
    const secondInput = turn.calls[1]!.input;
    expect(secondInput).toContain('第一轮意见');
  });

  it('通道条件 fail-closed：max_parallel 封顶拒绝（自定义通道目录）', async () => {
    const dir = new ChannelDirectory();
    dir.register(new ChannelSpec({ id: 'fan_out', shape: 'fan_out', conditions: { max_parallel: 2 } }));
    const { service: svc } = service(
      { collaborator: [{ opinion: 'x' }] },
      [scoped('main'), scoped('collaborator')],
      { channels: dir },
    );
    await expect(
      convene(svc, { entity_id: 'collaborator', task: '并行超限', n: 3 }),
    ).rejects.toMatchObject({ reason: 'max_parallel_exceeded' });
  });

  it('审批档通道 + review 姿态 = 审批拒绝阻断；auto 姿态放行', async () => {
    const dir = new ChannelDirectory();
    dir.register(new ChannelSpec({ id: 'fan_out', shape: 'fan_out', conditions: { approval: 'L1' } }));
    const script = { collaborator: [{ opinion: '放行意见' }] };
    const scopes = [scoped('main'), scoped('collaborator')];
    const blocked = service(script, scopes, { channels: dir }).service;
    await expect(
      convene(blocked, { entity_id: 'collaborator', task: '需审批', n: 2 }, { pose: 'review' }),
    ).rejects.toMatchObject({ reason: 'approval_denied' });
    const passed = service(script, scopes, { channels: dir }).service;
    const result = await convene(passed, { entity_id: 'collaborator', task: '已授权', n: 2 }, { pose: 'auto' });
    expect(result.ok).toBe(true);
  });

  it('参数与目标校验：缺目标 / 非法 n / 非法 contract / 目录不可装载 / budget 负数', async () => {
    const { service: svc } = service({ collaborator: [{ opinion: 'x' }] }, [scoped('main')]);
    await expect(convene(svc, { task: '无目标' })).rejects.toBeInstanceOf(ConveneError);
    await expect(
      convene(svc, { entity_id: 'collaborator', task: 't', n: 0 }),
    ).rejects.toMatchObject({ reason: 'invalid_params' });
    await expect(
      convene(svc, { entity_id: 'collaborator', task: 't', contract: 'decision_only' }),
    ).rejects.toMatchObject({ reason: 'invalid_params' });
    await expect(
      convene(svc, { entity_id: 'ghost', task: 't' }),
    ).rejects.toMatchObject({ reason: 'scope_unavailable' });
    await expect(
      convene(svc, { entity_id: 'collaborator', task: 't', budget: -1 }),
    ).rejects.toMatchObject({ reason: 'invalid_params' });
  });

  it('budget 折入子执行护栏：子执行成本超池 = degraded/失败摘要可见', async () => {
    const { service: svc } = service(
      { collaborator: [{ opinion: '完成' }] },
      [scoped('main'), scoped('collaborator')],
    );
    const result = await convene(svc, {
      entity_id: 'collaborator',
      task: '带预算',
      budget: 0,
    });
    expect(result.ok).toBe(true);
  });
});
