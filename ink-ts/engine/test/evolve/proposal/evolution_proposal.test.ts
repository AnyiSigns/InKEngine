/**
 * 受控演化提案数据面单测（evolution_proposal.ts）。
 *
 * 覆盖：
 * - 词表：九种提案种类（作用域/通道/先验覆盖三分组齐全）、三种来源、
 *   kind 类型守卫；
 * - 结构校验 fail-closed：缺载荷/载荷形态非法（asset 缺 id 或 scope、
 *   通道 shape 词表外、shortcut 缺字段、downrank 权重/模式非法）、
 *   provenance/kind/confidence 非法；
 * - to/from_dict round-trip 与最小序列化（空 evidence/meta/rationale 省略）；
 * - 零漂移：旧/精简声明可解析，未知键忽略，round-trip 保持等价。
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_EVOLUTION_KINDS,
  EVOLUTION_KIND_ORDER,
  EVOLUTION_PROVENANCES,
  EvolutionProposal,
  PRIOR_EVOLUTION_KINDS,
  PROVENANCE_AGENT,
  PROVENANCE_ORG,
  PROVENANCE_USER,
  SCOPE_EVOLUTION_KINDS,
  is_channel_kind,
  is_prior_kind,
  is_scope_kind,
} from '../../../src/evolve/proposal/evolution_proposal.js';

function scope_asset(id = 'planner', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, role: id, scope: { guard_level: 'L1' }, ...extra };
}

function channel_asset(id = 'delegate', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, shape: 'delegate', ...extra };
}

function proposal(kind: string, payload: Record<string, unknown>, kw: Record<string, unknown> = {}): EvolutionProposal {
  return new EvolutionProposal({
    kind: kind as never,
    payload,
    provenance: PROVENANCE_USER,
    ...kw,
  });
}

describe('提案种类与来源词表', () => {
  it('九种种类 = 作用域(3) + 通道(3) + 先验覆盖(3)，守卫覆盖全量', () => {
    expect(EVOLUTION_KIND_ORDER).toHaveLength(9);
    expect(SCOPE_EVOLUTION_KINDS).toEqual(['add_scope', 'update_scope', 'retire_scope']);
    expect(CHANNEL_EVOLUTION_KINDS).toEqual(['add_channel', 'update_channel', 'seal_channel']);
    expect(PRIOR_EVOLUTION_KINDS).toEqual(['update_prior', 'apply_shortcut', 'downrank']);
    for (const kind of EVOLUTION_KIND_ORDER) {
      const hit = is_scope_kind(kind) || is_channel_kind(kind) || is_prior_kind(kind);
      expect(hit).toBe(true);
    }
  });

  it('来源三值：user/agent_self/org_pruning', () => {
    expect(EVOLUTION_PROVENANCES).toEqual(['user', 'agent_self', 'org_pruning']);
    expect(PROVENANCE_USER).toBe('user');
    expect(PROVENANCE_AGENT).toBe('agent_self');
    expect(PROVENANCE_ORG).toBe('org_pruning');
  });
});

describe('提案构造校验（fail-closed）', () => {
  it('kind/provenance 词表外拒绝', () => {
    expect(() => proposal('teleport_scope', { asset: scope_asset() })).toThrow(/kind 非法/);
    expect(() =>
      new EvolutionProposal({
        kind: 'add_scope',
        payload: { asset: scope_asset() },
        provenance: 'host' as never,
      }),
    ).toThrow(/provenance 非法/);
  });

  it('载荷缺失/类型非法拒绝', () => {
    expect(() => proposal('retire_scope', {})).toThrow(/缺 scope/);
    expect(() => proposal('seal_channel', { channel: 3 })).toThrow(/缺 channel/);
    expect(() => proposal('add_scope', { asset: { id: 'x' } })).toThrow(/scope/);
    expect(() => proposal('add_channel', { asset: { id: 'x', shape: 'teleport' } })).toThrow(/shape 非法/);
    expect(() => proposal('apply_shortcut', { from: '', to: 'coder', skip_scope: 'planner' })).toThrow(/缺 from/);
  });

  it('downrank 权重/模式词表校验（权重 (0,1]、shape/commit 走通道词表）', () => {
    const good = { mode: { from: 'main', to: 'coder', shape: 'delegate', commit: 'full' }, weight: 0.5 };
    expect(() => proposal('downrank', good)).not.toThrow();
    expect(() => proposal('downrank', { ...good, weight: 0 })).toThrow(/weight 非法/);
    expect(() => proposal('downrank', { ...good, weight: 1.5 })).toThrow(/weight 非法/);
    expect(() =>
      proposal('downrank', { mode: { from: 'a', to: 'b', shape: 'beam', commit: 'full' }, weight: 0.5 }),
    ).toThrow(/mode\.shape 非法/);
    expect(() =>
      proposal('downrank', { mode: { from: 'a', to: 'b', shape: 'delegate', commit: 'partial' }, weight: 0.5 }),
    ).toThrow(/mode\.commit 非法/);
  });

  it('confidence 须 [0,1] 或省略', () => {
    expect(() => proposal('retire_scope', { scope: 'x' }, { confidence: 1.2 })).toThrow(/confidence 非法/);
    expect(() => proposal('retire_scope', { scope: 'x' }, { confidence: -0.1 })).toThrow(/confidence 非法/);
    expect(proposal('retire_scope', { scope: 'x' }).confidence).toBeNull();
  });
});

describe('提案 round-trip 与序列化', () => {
  it('带证据/置信度/理由的 round-trip 保持全字段', () => {
    const p = new EvolutionProposal({
      kind: 'update_scope',
      payload: { asset: scope_asset('planner', { persona: '新版主持人' }) },
      provenance: PROVENANCE_ORG,
      confidence: 0.62,
      evidence: { observations: 12, failure_rate: 0.4 },
      rationale: '择优更新 planner 能力',
      meta: { round_id: 'r1' },
    });
    const restored = EvolutionProposal.from_dict(p.to_dict());
    expect(restored).toEqual(p);
    expect(restored.kind).toBe('update_scope');
    expect(restored.confidence).toBe(0.62);
  });

  it('最小序列化：空 evidence/meta/rationale 省略，round-trip 等价', () => {
    const p = proposal('seal_channel', { channel: 'delegate' });
    expect(p.to_dict()).toEqual({ kind: 'seal_channel', payload: { channel: 'delegate' }, provenance: 'user' });
    const restored = EvolutionProposal.from_dict(p.to_dict());
    expect(restored).toEqual(p);
    expect(restored.evidence).toEqual({});
    expect(restored.meta).toEqual({});
    expect(restored.rationale).toBe('');
  });

  it('精简/旧声明可解析：未知键忽略，缺可选字段回落缺省', () => {
    const dict = {
      kind: 'retire_scope',
      payload: { scope: 'tester', reason: '低使用' },
      provenance: 'org_pruning',
      future_field: { a: 1 },
    };
    const p = EvolutionProposal.from_dict(dict);
    expect(p.provenance).toBe('org_pruning');
    expect(p.confidence).toBeNull();
    const again = EvolutionProposal.from_dict(p.to_dict());
    expect(again).toEqual(p);
  });

  it('asset_record 取数（作用域/通道 asset 载荷；非 asset 载荷 = null）', () => {
    expect(proposal('add_channel', { asset: channel_asset('fan_out', { shape: 'fan_out' }) }).asset_record()?.['id']).toBe('fan_out');
    expect(proposal('seal_channel', { channel: 'delegate' }).asset_record()).toBeNull();
  });
});
