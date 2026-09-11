/**
 * 临时协作观测（sighting）追加链单测（convene_board/convene：观测行构造 +
 * best-effort 追加 + 失败留痕）。
 *
 * 测什么：
 * - 临时作用域召集：每路子执行（含失败路）settle 后各追加一条观测行，字段齐
 *   （role/def 摘要 person·model/outcome/run_id/seat/times=1/ts），多轮 × 多路
 *   计次不重不漏；
 * - 目录作用域召集 = 零观测行（结晶证据只来自临时模式）；
 * - make_temp_sighting 直测：temp 目标产行、目录目标 null、缺 temp_def null；
 * - summarize_temp_def 摘要过滤：context_refs 等噪声键不入行，model/capabilities
 *   原样携带；
 * - sink 抛错 = best-effort：召集回执照常 ok，whiteboard_audit 同款事件留痕
 *   （kind='temp_sighting' + action='append_failed'+ error），失败不静默。
 */
import { describe, expect, it } from 'vitest';

import { EntitySpec } from '@ink-ts/engine';
import type { RunEvent, ScopeTurnContext, ScopeTurnResult } from '@ink-ts/engine';

import { HostExecutionService } from '../src/execution/service.js';
import { resolve_convene_target, summarize_temp_def } from '../src/execution/convene_params.js';
import { convene } from '../src/execution/convene.js';
import { make_temp_sighting, record_temp_sighting } from '../src/execution/convene_board.js';

type ScriptItem = Record<string, unknown> | { fail: true; reason: string };

/** fake turn：按作用域 role 剧本逐轮吐载荷（临时作用域每轮 id 不同，按 role 路由）。 */
class RoleTurn {
  constructor(private script: Record<string, ScriptItem[]>) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    const role = String((ctx.scope as unknown as { role?: string }).role ?? ctx.scope.id);
    const item = (this.script[role] ?? this.script[ctx.scope.id])?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { opinion: '默认意见' } };
    if ('fail' in item) {
      return { ok: false, reply: '', reason: String(item.reason), summary: `${role} ${String(item.reason)}` };
    }
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

function scoped(id: string, persona = `${id} 作用域`): EntitySpec {
  return new EntitySpec({ id, role: id, persona, model: null });
}

function makeService(script: Record<string, ScriptItem[]>): HostExecutionService {
  return new HostExecutionService({
    loadScope: ((id: string) => (id === 'main' ? scoped('main') : null)) as never,
    turnOverride: new RoleTurn(script) as never,
  });
}

const TEMP_ARGS = {
  scope: {
    role: 'debater',
    persona: '负责唱反调',
    model: { provider: 'p1', model_id: 'm1' },
    capabilities: [{ id: 'opinion', class: 'function' }],
    context_refs: ['噪声键不应入行'],
  },
  task: '挑战结论',
  n: 2,
};

describe('convene 临时作用域 sighting 追加', () => {
  it('每路 settle 各一条：字段齐备（role/def 摘要/outcome/run_id/seat/times/ts）', async () => {
    const rows: Record<string, unknown>[] = [];
    const svc = makeService({ debater: [{ opinion: '反方一' }, { opinion: '反方二' }], main: [{ conclusion: '综合' }] });
    const result = await convene(svc, TEMP_ARGS, {}, {
      sightingSink: async (r) => { rows.push(r); },
      clock: () => 1700,
    });
    expect(result.ok).toBe(true);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row['role']).toBe('debater');
      expect(row['outcome']).toBe('success');
      expect(row['times']).toBe(1);
      expect(row['ts']).toBe(1700);
      const def = row['def'] as Record<string, unknown>;
      expect(def['persona']).toBe('负责唱反调');
      expect((def['model'] as Record<string, unknown>)['model_id']).toBe('m1');
      expect('context_refs' in def).toBe(false);
    }
    expect(new Set(rows.map((r) => `${String(r['run_id'])}#${String(r['seat'])}`)).size).toBe(2);
  });

  it('失败路也记录（outcome=failure 是证据票）；多轮 × 多路不重不漏', async () => {
    const rows: Record<string, unknown>[] = [];
    const svc = makeService({
      debater: [
        { opinion: '一轮一' },
        { fail: true, reason: '模型越权' },
        { opinion: '二轮一', verdict: '确认' },
        { opinion: '二轮二' },
      ],
      main: [{ conclusion: '综合' }],
    });
    await convene(svc, { ...TEMP_ARGS, n: 2, mode: 'open', rounds: 2 }, {}, {
      sightingSink: async (r) => { rows.push(r); },
    });
    expect(rows).toHaveLength(4);
    const keys = rows.map((r) => `${String(r['run_id'])}#${String(r['seat'])}`);
    expect(new Set(keys).size).toBe(4);
    expect(rows.map((r) => r['outcome'])).toContain('failure');
  });

  it('目录作用域召集 = 零观测行（观测只来自临时模式）', async () => {
    const rows: Record<string, unknown>[] = [];
    const loader = {
      main: scoped('main'),
      collaborator: scoped('collaborator'),
    };
    const svc = new HostExecutionService({
      loadScope: ((id: string) => loader[id as keyof typeof loader] ?? null) as never,
      turnOverride: new RoleTurn({ collaborator: [{ opinion: 'x' }], main: [{ conclusion: 'ok' }] }) as never,
    });
    await convene(svc, { entity_id: 'collaborator', task: '出意见', n: 2 }, {}, {
      sightingSink: async (r) => { rows.push(r); },
    });
    expect(rows).toHaveLength(0);
  });

  it('sink 抛错 = best-effort：回执照常 + whiteboard_audit 同款事件留痕', async () => {
    const events: RunEvent[] = [];
    const svc = makeService({ debater: [{ opinion: '反方' }], main: [{ conclusion: '综合' }] });
    const result = await convene(svc, { ...TEMP_ARGS, n: 1 }, { onEvent: (e) => events.push(e) }, {
      sightingSink: async () => {
        throw new Error('storage 已关停');
      },
    });
    expect(result.ok).toBe(true);
    const failed = events.find((e) => (e.detail as Record<string, unknown>)?.['kind'] === 'temp_sighting');
    expect(failed).toBeDefined();
    expect(failed!.action).toBe('whiteboard_audit');
    expect((failed!.detail as Record<string, unknown>)['action']).toBe('append_failed');
    expect(String((failed!.detail as Record<string, unknown>)['error'])).toContain('storage 已关停');
  });
});

describe('sighting 构造单元（make_temp_sighting / summarize_temp_def）', () => {
  it('temp 目标产行；目录/缺定义目标 null', () => {
    const tempTarget = resolve_convene_target({ scope: { role: 'analyst' }, task: 't' });
    const dirTarget = resolve_convene_target({ entity_id: 'collaborator', task: 't' });
    const row = make_temp_sighting(tempTarget, 'collab:1:1', 0, 'success', 42);
    expect(row).not.toBeNull();
    expect(row!['role']).toBe('analyst');
    expect(row!['run_id']).toBe('collab:1:1');
    expect(row!['seat']).toBe(0);
    expect(row!['def']).toEqual({ role: 'analyst' });
    expect(make_temp_sighting(dirTarget, 'collab:1:1', 0, 'success', 42)).toBeNull();
    expect(make_temp_sighting({ ...tempTarget, temp_def: null }, 'r', 0, 'success', 1)).toBeNull();
  });

  it('摘要过滤：只带身份维度键，model 空 dict 不带', () => {
    const def = summarize_temp_def({
      role: 'debater',
      persona: 'p',
      label: 'L',
      model: {},
      rules: ['r1'],
      contract: null,
      constraints: { noise: 1 },
    });
    expect(def).toEqual({ role: 'debater', persona: 'p', label: 'L', rules: ['r1'] });
  });

  it('direct record_temp_sighting：无 sink / null 记录 = 静默零动作', async () => {
    await record_temp_sighting(undefined, { role: 'x' }, undefined, 'p');
    await record_temp_sighting(async () => {
      throw new Error('不该被调用');
    }, null, undefined, 'p');
    expect(true).toBe(true);
  });
});
