/**
 * 执行运行时主路径测试（execution_runtime.ts + run_loop.ts，fake turn）。
 *
 * 测什么：
 * - 直答收口：无 `__next` = 兜底直收，汇聚点合成单份最终产物；
 * - delegate(1→1) + 回传：主作用域委托子代理 → 子 run 独立轨迹/成本 → 产物按
 *   scope 键并入主载荷；
 * - fan-out(1→N) 并行 + fan-in full/best/decision_only 归并；降级/失败子执行
 *   只产摘要；
 * - 无 `__next` 先验回落（入口 trigger 匹配 default_scope_priors）；
 * - 护栏与通道条件 fail-closed：步数上限 / 审批拒绝 / 资格墙 / 并行上限 /
 *   成本池超限 / 未知目标作用域 → run 失败（阻断原因可见）；
 * - 轨迹写入组织档案：run 收尾 ingest 到 Wave-2 OrgArchive（转场/作用域统计）。
 */
import { describe, expect, it } from 'vitest';

import { ChannelDirectory, default_channel_seeds } from '../../../src/core/channels/channel_directory.js';
import { ChannelSpec } from '../../../src/core/channels/channel_spec.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import { OrgArchive } from '../../../src/core/org_archive/org_archive.js';
import { ExecutionRuntime } from '../../../src/core/execution_runtime/execution_runtime.js';
import type { ScopeTurnResult } from '../../../src/core/execution_runtime/scope_turn.js';
import type { ExecutionRuntimeDeps, ScopeTurnContext } from '../../../src/core/execution_runtime/runtime_types.js';

function entity(id: string, persona: string): EntitySpec {
  return new EntitySpec({ id, role: id, persona, model: null });
}

/** fake turn：按作用域剧本逐轮吐载荷（JSON dict 或失败标记）。 */
class FakeTurn {
  readonly calls: string[] = [];
  constructor(private script: Record<string, Array<Record<string, unknown> | { fail: true; reason: string }>>) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    this.calls.push(ctx.scope.id);
    const item = this.script[ctx.scope.id]?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { message: '（缺省直答）' } };
    if ('fail' in item) {
      const reason = item.reason as string;
      return { ok: false, reply: '', reason, summary: `${ctx.scope.id} ${reason}` };
    }
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

function deps(
  script: Record<string, Array<Record<string, unknown> | { fail: true; reason: string }>>,
  extra: Partial<ExecutionRuntimeDeps> = {},
): ExecutionRuntimeDeps {
  const scopes = new Map<string, EntitySpec>();
  for (const id of Object.keys(script)) scopes.set(id, entity(id, `${id} 作用域`));
  scopes.set('main', entity('main', '主持人'));
  scopes.set('subagent', entity('subagent', '子代理'));
  scopes.set('collaborator', entity('collaborator', '协作者'));
  scopes.set('planner', entity('planner', '规划'));
  const turn = new FakeTurn(script);
  return {
    load_scope: (id) => scopes.get(id) ?? null,
    channels: default_channels(),
    turn,
    approval: async (): Promise<'accept' | 'auto' | 'reject'> => 'accept',
    ...extra,
  };
}

function default_channels(): ChannelDirectory {
  const d = new ChannelDirectory();
  for (const spec of default_channel_seeds()) d.register(spec);
  return d;
}

async function runMain(script: Record<string, Array<Record<string, unknown> | { fail: true; reason: string }>>, extra: Partial<ExecutionRuntimeDeps> = {}, opts: { task?: string; trigger?: string | null } = {}) {
  const runtime = new ExecutionRuntime(deps(script, extra));
  return runtime.run({ task: opts.task ?? '做一件事', trigger: opts.trigger ?? null });
}

describe('直答收口与汇聚点单份最终产物', () => {
  it('无 `__next`：主持人兜底直收，无转场轨迹，单份最终产物', async () => {
    const result = await runMain({ main: [{ message: '你好，这是直答' }] });
    expect(result.root.outcome).toBe('success');
    expect(result.root.hops).toEqual([]);
    expect(result.final_product['message']).toBe('你好，这是直答');
    expect(result.runs.length).toBe(1);
  });
});

describe('delegate(1→1) + 回传', () => {
  it('主持人委托子代理：子 run 独立 entry/成本，产物按 scope 键并入主载荷', async () => {
    const result = await runMain({
      main: [{ __next: { kind: 'scope', target: 'subagent' } }, { message: '按子代理结论答复' }],
      subagent: [{ answer: '子代理查证结果' }],
    });
    expect(result.root.outcome).toBe('success');
    expect(result.runs.length).toBe(2);
    const child = result.runs.find((r) => r.parent_run_id === result.root.run_id);
    expect(child?.entry_scope).toBe('subagent');
    const payload = result.final_product;
    expect(payload['message']).toBe('按子代理结论答复');
    expect((payload['subagent'] as Record<string, unknown>)['answer']).toBe('子代理查证结果');
    const shapes = result.root.hops.map((h) => h.shape);
    expect(shapes).toEqual(['delegate', 'return']);
  });
});

describe('fan-out(1→N) 并行 + fan-in 归并', () => {
  it('full：N 路并行子执行归并入 results 面（主载荷）+ 汇总答复', async () => {
    const result = await runMain({
      main: [{ __next: { kind: 'channel', channel: 'fan_out', target: 'collaborator', count: 3 } }, { message: '三意见裁决' }],
      collaborator: [
        { opinion: 'o1' },
        { opinion: 'o2' },
        { opinion: 'o3' },
      ],
    });
    expect(result.root.outcome).toBe('success');
    expect(result.runs.length).toBe(4);
    expect(result.root.hops.some((h) => h.shape === 'fan_out' && h.count === 3)).toBe(true);
    expect(result.root.hops.some((h) => h.shape === 'fan_in' && h.count === 3)).toBe(true);
    const list = result.final_product['collaborator'] as Array<Record<string, unknown>>;
    expect(list.length).toBe(3);
    expect(result.final_product['message']).toBe('三意见裁决');
  });

  it('best：质量择优只采纳单份（落选保留 but 隔离 adopted=false）', async () => {
    const result = await runMain({
      main: [{ __next: { kind: 'channel', channel: 'fan_out', target: 'collaborator', count: 2, contract: 'best' } }, { message: '采用最优' }],
      collaborator: [
        { opinion: 'low', _quality: 1 },
        { opinion: 'high', _quality: 9 },
      ],
    });
    expect(result.root.outcome).toBe('success');
    const product = result.final_product['collaborator'] as Record<string, unknown>;
    expect(product['opinion']).toBe('high');
    expect(result.root.children.some((c) => c.adopted === false)).toBe(true);
  });

  it('decision_only：产物不并入主载荷，只留采纳决策', async () => {
    const result = await runMain({
      main: [{ __next: { kind: 'channel', channel: 'fan_out', target: 'collaborator', count: 2, contract: 'decision_only' } }, { message: '试跑判定完成' }],
      collaborator: [{ opinion: 'x' }, { opinion: 'y' }],
    });
    expect(result.root.outcome).toBe('success');
    expect(result.final_product['decision']).toBe(true);
    expect(result.final_product['collaborator']).toBeUndefined();
  });

  it('降级/失败子执行：只产摘要（degraded），原始产物不入主载荷', async () => {
    const result = await runMain({
      main: [{ __next: { kind: 'channel', channel: 'fan_out', target: 'collaborator', count: 2 } }, { message: '汇总结论' }],
      collaborator: [{ opinion: 'ok' }, { fail: true, reason: '工具执行异常' }],
    });
    expect(result.root.outcome).toBe('degraded');
    expect(result.final_product['degraded']).toEqual(['collaborator 工具执行异常']);
    const kept = result.final_product['collaborator'] as Record<string, unknown>;
    expect(kept['opinion']).toBe('ok');
  });
});

describe('无 `__next` 的先验回落（入口 trigger）', () => {
  it('trigger=delegation：入口首轮回落先验 → delegate 子代理', async () => {
    const result = await runMain(
      {
        main: [{ message: '这是个专门子任务，转给子代理' }, { message: '任务完成' }],
        subagent: [{ answer: '子结果' }],
      },
      {},
      { trigger: 'delegation' },
    );
    expect(result.root.outcome).toBe('success');
    expect(result.runs.some((r) => r.entry_scope === 'subagent')).toBe(true);
    expect(result.root.hops.some((h) => h.shape === 'delegate')).toBe(true);
    expect(result.final_product['message']).toBe('任务完成');
  });

  it('trigger=casual：入口首轮回落先验 → 短路直收（无转场）', async () => {
    const result = await runMain(
      { main: [{ message: '寒暄一句' }] },
      {},
      { trigger: 'casual' },
    );
    expect(result.root.outcome).toBe('success');
    expect(result.root.hops).toEqual([]);
    expect(result.final_product['message']).toBe('寒暄一句');
  });
});

describe('护栏与通道条件（fail-closed）', () => {
  it('步数护栏：子执行返回后主持续跑超限 → run 失败', async () => {
    const result = await runMain(
      { main: [{ __next: { kind: 'scope', target: 'subagent' } }, { message: '第二轮' }], subagent: [{ answer: 'x' }] },
      { guardrails: { max_steps: 1 } },
    );
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('执行步数超限');
  });

  it('审批拒绝：通道声明审批档 + reject → 转场阻断（fail-closed）', async () => {
    const d = default_channels();
    d.register(new ChannelSpec({ id: 'guarded', shape: 'delegate', conditions: { approval: 'L2' } }));
    const result = await runMain(
      { main: [{ __next: { kind: 'channel', channel: 'guarded', target: 'subagent' } }], subagent: [{ answer: 'x' }] },
      { channels: d, approval: async (): Promise<'accept' | 'auto' | 'reject'> => 'reject' },
    );
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('审批档');
  });

  it('资格墙：通道资格清单不含当前作用域 → eligibility_denied', async () => {
    const d = default_channels();
    d.register(new ChannelSpec({ id: 'inner', shape: 'delegate', conditions: { eligibility: ['planner'] } }));
    const result = await runMain(
      { main: [{ __next: { kind: 'channel', channel: 'inner', target: 'subagent' } }] },
      { channels: d },
    );
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('资格墙');
  });

  it('最大并行：声明路数超通道上限 → max_parallel_exceeded', async () => {
    const d = default_channels();
    d.register(new ChannelSpec({ id: 'narrow', shape: 'fan_out', conditions: { max_parallel: 2 } }));
    const result = await runMain(
      { main: [{ __next: { kind: 'channel', channel: 'narrow', target: 'collaborator', count: 3 } }] },
      { channels: d },
    );
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('并行上限');
  });

  it('成本池：转场成本超通道成本池 → cost_pool_exceeded', async () => {
    const d = default_channels();
    d.register(new ChannelSpec({ id: 'budgeted', shape: 'delegate', conditions: { cost_pool_cap: 5 } }));
    const result = await runMain(
      { main: [{ __next: { kind: 'channel', channel: 'budgeted', target: 'subagent' } }], subagent: [{ answer: 'x' }] },
      { channels: d, estimate_cost: () => 6 },
    );
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('成本池上限');
  });

  it('目标作用域未注册：路由规划拒绝 → 显式失败（不臆造目标）', async () => {
    const result = await runMain({ main: [{ __next: { kind: 'scope', target: 'ghost' } }] });
    expect(result.root.outcome).toBe('failure');
    expect(result.root.error).toContain('scope_unknown');
  });
});

describe('轨迹写入组织档案（Wave-2 OrgArchive，in-memory ingest）', () => {
  it('run 收尾逐条 ingest 轨迹：转场模式与作用域使用统计可查（fan-out 真实发生）', async () => {
    const archive = new OrgArchive();
    const result = await runMain(
      {
        main: [{ __next: { kind: 'channel', channel: 'fan_out', target: 'collaborator', count: 2 } }, { message: '双意见裁决' }],
        collaborator: [{ opinion: 'a' }, { opinion: 'b' }],
      },
      { archive },
    );
    // 根 + 2 子各自一条轨迹，全部 ingest
    expect(result.trails.length).toBe(3);
    expect(archive.ingested_count()).toBe(3);
    // 转场模式：main →(fan_out/full) collaborator 观测 1 次且成功
    const fan = archive.transition_stats('main', 'collaborator', 'fan_out');
    expect(fan?.count).toBe(1);
    expect(fan?.success).toBe(1);
    // 作用域使用统计：collaborator 收尾执行 2 次（两路子执行）
    expect(archive.scope_usage('collaborator')?.success).toBe(2);
    expect(archive.scope_usage('main')?.success).toBe(1);
  });
});
