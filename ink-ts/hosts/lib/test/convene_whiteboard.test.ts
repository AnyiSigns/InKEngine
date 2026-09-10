/**
 * convene 白板驱动协作 E2E（hosts/lib/test/convene_whiteboard.test.ts）。
 *
 * 测什么（blind/open 全链，fake turn 隔离引擎装载——机制语义在引擎已由引擎测试
 * 锚定，这里验证召集编排与白板接线的回执面）：
 * - blind 全链：convene 建白板 → main 写任务块 → N 路子执行经 W6A3 穿透只取
 *   被授权视图（互不见他人意见）→ 宿主代写私有意见块（owner=席位身份）→
 *   W6C1 裁决（去重/冲突对/仲裁建议）→ main 裁决 turn 消费综合结构出结论 →
 *   写结论块；
 * - open 圆桌：意见块升级共享，后轮子执行经白板视图看到前轮意见；judge_round
 *   三判据接线（no_new_substantive / confirmed_by_k 收敛出结论，rounds_exhausted
 *   不收敛不加轮——main 拍板 + 降级摘要可见）；
 * - 冲突对出现在裁决回执（merged.conflicts，含仲裁建议）；
 * - schema 门禁：协作方 produces 契约不符的意见剔除并记失败清单（merged.rejected）；
 * - 审计：whiteboard_audit 事件（main 写任务/结论、宿主代写意见、子执行读块）
 *   到达既有 onEvent 事件通道；
 * - 临时作用域：temp_scope id 预授命中（子执行授权视图拿到任务块）。
 */
import { describe, expect, it } from 'vitest';

import {
  EntitySpec,
  build_scope_asset,
} from '@ink-ts/engine';
import type {
  RunEvent,
  ScopeTurnContext,
  ScopeTurnResult,
} from '@ink-ts/engine';

/** 被授权块视图（ScopeTurnContext.whiteboard_blocks 元素同构；引擎公共面未透出类型名）。 */
type BlockView = {
  readonly kind: 'task' | 'opinion' | 'board' | 'conclusion' | 'summary';
  readonly owner: string;
  readonly content: string;
  readonly seq: number;
};

import { HostExecutionService } from '../src/execution/service.js';
import { convene } from '../src/execution/convene.js';

type ScriptItem = Record<string, unknown>;

/** fake turn：按作用域 id（临时作用域按 role）派发剧本，并捕获输入与授权视图。 */
class FakeTurn {
  readonly calls: Array<{
    scopeId: string;
    role: string | null;
    input: string;
    blocks: readonly BlockView[] | undefined;
  }> = [];

  constructor(private script: Record<string, ScriptItem[]>) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    const role = (ctx.scope as unknown as { role?: string }).role ?? null;
    this.calls.push({ scopeId: ctx.scope.id, role, input: ctx.input, blocks: ctx.whiteboard_blocks });
    const key = ctx.scope.id.startsWith('temp_scope:') ? role : ctx.scope.id;
    const item = this.script[key as string]?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { message: '（缺省直答）' } };
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

function scope(id: string): EntitySpec {
  return new EntitySpec({ id, role: id, persona: `${id} 作用域`, model: null });
}

function loaderFor(scopes: EntitySpec[]): (id: string) => EntitySpec | null {
  const map = new Map(scopes.map((s) => [s.id, s]));
  return (id: string) => map.get(id) ?? null;
}

function fixture(script: Record<string, ScriptItem[]>, scopes: EntitySpec[]): { service: HostExecutionService; turn: FakeTurn } {
  const turn = new FakeTurn(script);
  const service = new HostExecutionService({
    loadScope: loaderFor(scopes) as never,
    turnOverride: turn as never,
  });
  return { service, turn };
}

function callsOf(turn: FakeTurn, scopeId: string): Array<{ input: string; blocks: readonly BlockView[] | undefined }> {
  return turn.calls.filter((c) => c.scopeId === scopeId);
}

/** 临时作用域的调用按 role 定位（记录的 scopeId = 运行时构造的 temp id）。 */
function callsOfRole(turn: FakeTurn, role: string): Array<{ input: string; blocks: readonly BlockView[] | undefined }> {
  return turn.calls.filter((c) => c.role === role);
}

describe('blind 全链（白板广播 → 隔离子执行 → 代写 → 裁决 → main turn 结论）', () => {
  it('两席 blind：互不见对方意见、冲突对入回执、main turn 消费 synthesis 出结论', async () => {
    const { service: svc, turn } = fixture(
      {
        analyst: [
          { opinion: '甲意见', verdict: '方案A' },
          { opinion: '乙意见', verdict: '方案B' },
        ],
        main: [{ conclusion: '综合两方案后的结论' }],
      },
      [scope('main'), scope('analyst')],
    );
    const events: RunEvent[] = [];
    const result = await convene(svc, { entity_id: 'analyst', task: '分析任务', n: 2 }, {
      onEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(true);

    // 隔离：每路子执行 input 只含被授权视图（任务块），不见他人意见
    const childCalls = callsOf(turn, 'analyst');
    expect(childCalls.length).toBe(2);
    expect(childCalls[0]!.input).toContain('分析任务');
    expect(childCalls[0]!.input).not.toContain('乙意见');
    expect(childCalls[0]!.blocks?.map((b) => b.kind)).toEqual(['task']);
    expect(childCalls[1]!.input).toContain('分析任务');
    expect(childCalls[1]!.input).not.toContain('甲意见');

    // main 裁决 turn：全量可见（两份意见在场）+ synthesis 载荷投影在场
    const mainCalls = callsOf(turn, 'main');
    expect(mainCalls.length).toBe(1);
    expect(mainCalls[0]!.input).toContain('甲意见');
    expect(mainCalls[0]!.input).toContain('乙意见');
    expect(mainCalls[0]!.input).toContain('points');
    expect(mainCalls[0]!.input).toContain('conflicts');

    // 结论 = main turn 产物；意见块代写为两个席位身份
    expect(result.conclusion).toBe('综合两方案后的结论');
    const opinions = result.merged['points'] as Array<{ owner: string; content: string }>;
    expect(opinions.map((p) => p.owner).sort()).toEqual(['analyst#1', 'analyst#2']);

    // 冲突对出现在裁决回执：显式结论不同 → verdict 对，先验档建议（seq 小者）
    const conflicts = result.merged['conflicts'] as Array<{
      kind: string;
      a: { owner: string };
      b: { owner: string };
      suggestion: { side: string | null; basis: string };
    }>;
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.kind).toBe('verdict');
    expect(conflicts[0]!.a.owner).toBe('analyst#1');
    expect(conflicts[0]!.b.owner).toBe('analyst#2');
    expect(conflicts[0]!.suggestion).toEqual({ side: 'a', basis: 'prior' });
  });

  it('审计事件到达既有通道：main 写块 / 宿主代写意见 / 子执行读块均经 onEvent', async () => {
    const { service: svc } = fixture(
      { analyst: [{ opinion: '唯一意见' }], main: [{ conclusion: '结论' }] },
      [scope('main'), scope('analyst')],
    );
    const events: RunEvent[] = [];
    await convene(svc, { entity_id: 'analyst', task: '审计任务', n: 1 }, {
      onEvent: (e) => events.push(e),
    });
    const details = events
      .filter((e) => e.action === 'whiteboard_audit')
      .map((e) => e.detail as Record<string, unknown>);
    expect(details.length).toBeGreaterThan(0);
    // main 写任务块/结论块（召集命名空间 run 归属）
    expect(details).toContainEqual(expect.objectContaining({ scope: 'main', kind: 'task', action: 'write' }));
    expect(details).toContainEqual(expect.objectContaining({ scope: 'main', kind: 'conclusion', action: 'write' }));
    // 宿主代写意见块（writer = 席位身份，子执行 run 归属）
    expect(details).toContainEqual(expect.objectContaining({ scope: 'analyst#1', kind: 'opinion', action: 'write' }));
    // 子执行读审计（W6A3 通道转发：子执行以目录 id 读任务块）
    expect(details).toContainEqual(expect.objectContaining({ scope: 'analyst', kind: 'task', action: 'read' }));
  });
});

describe('open 圆桌（意见块升级共享 + judge_round 三判据接线）', () => {
  it('后轮经白板视图看到前轮意见；重复无新实质 → 收敛出结论', async () => {
    const { service: svc, turn } = fixture(
      {
        debater: [{ opinion: '第一轮看法' }, { opinion: '第一轮看法' }],
        main: [{ conclusion: '圆桌收敛结论' }],
      },
      [scope('main'), scope('debater')],
    );
    const result = await convene(svc, {
      entity_id: 'debater',
      task: '圆桌审议',
      n: 1,
      mode: 'open',
      rounds: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.rounds_run).toBe(2);
    const childCalls = callsOf(turn, 'debater');
    expect(childCalls.length).toBe(2);
    // 第二轮子执行看到第一轮意见（open 互见授权 + 白板快照下发）
    expect(childCalls[1]!.input).toContain('第一轮看法');
    expect(childCalls[1]!.blocks?.map((b) => b.kind)).toEqual(['task', 'opinion']);
    // digest 全等（同席前后轮同文）→ 收敛；结论 = main turn；无未收敛降级
    expect(result.merged['convergence']).toEqual({ converged: true, reason: 'no_new_substantive' });
    expect(result.conclusion).toBe('圆桌收敛结论');
    expect(result.degraded.join('；')).not.toContain('未收敛');
  });

  it('≥k 方确认 → confirmed_by_k 收敛（rounds_run=1）', async () => {
    const { service: svc } = fixture(
      {
        panel: [
          { opinion: '方案可行，同意' },
          { opinion: '方案可行，同意' },
        ],
        main: [{ conclusion: '多方确认后的结论' }],
      },
      [scope('main'), scope('panel')],
    );
    const result = await convene(svc, {
      entity_id: 'panel',
      task: '表决',
      n: 2,
      mode: 'open',
      rounds: 4,
    });
    expect(result.ok).toBe(true);
    expect(result.rounds_run).toBe(1);
    expect(result.merged['convergence']).toEqual({ converged: true, reason: 'confirmed_by_k' });
    expect(result.conclusion).toBe('多方确认后的结论');
  });

  it('触顶不收敛 → 不加轮、main 拍板、降级摘要可见（成本封顶）', async () => {
    const { service: svc } = fixture(
      {
        solo: [{ opinion: '看法一' }, { opinion: '看法二' }],
        main: [{ conclusion: '主持人拍板' }],
      },
      [scope('main'), scope('solo')],
    );
    const result = await convene(svc, {
      entity_id: 'solo',
      task: '僵局审议',
      n: 1,
      mode: 'open',
      rounds: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.rounds_run).toBe(2);
    expect(result.merged['convergence']).toEqual({ converged: false, reason: 'rounds_exhausted' });
    expect(result.degraded.join('；')).toContain('未收敛');
    expect(result.conclusion).toBe('主持人拍板');
  });
});

describe('护栏与门禁（schema 剔除记失败 / 临时作用域白板授权）', () => {
  it('协作方 produces 契约不符的意见剔除并记失败清单；无采纳时不跑 main turn', async () => {
    const auditor = build_scope_asset({
      id: 'auditor',
      role: 'auditor',
      persona: '带产出契约的审计员',
      model: null,
      contract: {
        produces: [
          {
            shape: 'field',
            key: 'opinion',
            schema: { name: 'opinion', fields: [{ name: 'confidence', kind: 'number', required: true }] },
          },
        ],
      },
    });
    const { service: svc, turn } = fixture(
      { auditor: [{ opinion: '缺置信度的意见' }], main: [{ conclusion: '不应到达' }] },
      [scope('main'), auditor],
    );
    const result = await convene(svc, { entity_id: 'auditor', task: '带契约审计', n: 1 });
    expect(result.ok).toBe(true);
    const rejected = result.merged['rejected'] as Array<{ owner: string; reasons: string[] }>;
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.owner).toBe('auditor#1');
    expect(rejected[0]!.reasons.join('；')).toContain('confidence');
    expect(result.merged['points']).toEqual([]);
    expect(callsOf(turn, 'main').length).toBe(0);
    expect(result.conclusion).toBe('（协作者无有效意见产出）');
  });

  it('临时作用域：temp_scope id 预授命中 grants，子执行授权视图拿到任务块', async () => {
    const { service: svc, turn } = fixture(
      { temp_debater: [{ opinion: '临时唱反调' }], main: [{ conclusion: '收口' }] },
      [scope('main')],
    );
    const result = await convene(svc, {
      scope: { role: 'temp_debater', persona: '现场定义' },
      task: '临时挑战',
      n: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.scope_source).toBe('temp');
    const childCalls = callsOfRole(turn, 'temp_debater');
    expect(childCalls.length).toBe(1);
    expect(turn.calls[0]!.scopeId).toMatch(/^temp_scope:/);
    // temp id 命中名册授权 → 任务块进授权视图（视图 key = 运行时构造的 temp id）
    expect(childCalls[0]!.input).toContain('临时挑战');
    expect(childCalls[0]!.blocks?.map((b) => b.kind)).toEqual(['task']);
    expect(result.conclusion).toBe('收口');
  });
});
