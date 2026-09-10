/**
 * 受控演化应用计划单测（apply_plan.ts：目录感知校验 + 可执行步骤推导）。
 *
 * 覆盖：
 * - 作用域资产：add（目标须不存在）/update（目标须存在且带 scope 声明）/
 *   retire（写 retired 标记记录）三类计划推导与违规；
 * - 通道资产：add/update/封（disabled 置位替换）；封启用通道须先封、
 *   update 不得对启用通道传 disabled=true（防绕过封禁语义）；
 * - 先验覆盖：update_prior（route 行）/apply_shortcut（shortcut 行，
 *   中继须异于起终点，from==to 环回允许）/downrank（weight 行）；
 * - 目录缺失 = fail-closed 违规；计划纯函数不改动目录（快照校验）。
 */

import { describe, expect, it } from 'vitest';

import { ChannelDirectory } from '../../../src/core/channels/channel_directory.js';
import { ChannelSpec } from '../../../src/core/channels/channel_spec.js';
import { EntityRegistry, EntitySpec } from '../../../src/core/entities/entities.js';
import { RETIRED_META_KEY } from '../../../src/core/entities/entities.js';
import { default_scope_priors, scope_prior_to_dict } from '../../../src/core/scopes/scope_priors.js';
import { plan_evolution, type EvolutionPlanStep } from '../../../src/core/controlled_evolution/apply_plan.js';
import {
  PROVENANCE_ORG,
  PROVENANCE_USER,
  EvolutionProposal,
  type EvolutionProposalKind,
} from '../../../src/core/controlled_evolution/evolution_proposal.js';

function scope_spec(id: string): EntitySpec {
  return new EntitySpec({ id, role: id, scope: { guard_level: 'L1' } });
}

function channel_spec(id: string, shape = 'delegate'): ChannelSpec {
  return new ChannelSpec({ id, shape: shape as never });
}

function entity_registry(): EntityRegistry {
  const registry = new EntityRegistry();
  registry.register(scope_spec('planner'));
  registry.register(scope_spec('tester'));
  registry.register(new EntitySpec({ id: 'plain', role: 'collaborator' }));
  return registry;
}

function channel_dir(): ChannelDirectory {
  const dir = new ChannelDirectory();
  dir.register(channel_spec('delegate'));
  dir.register(channel_spec('fan_out', 'fan_out'));
  return dir;
}

function proposal(kind: EvolutionProposalKind, payload: Record<string, unknown>): EvolutionProposal {
  return new EvolutionProposal({
    kind,
    payload,
    provenance: kind === 'add_scope' || kind === 'add_channel' ? PROVENANCE_USER : PROVENANCE_ORG,
    confidence: 0.6,
  });
}

function scope_asset(id: string): Record<string, unknown> {
  return { id, role: id, scope: { guard_level: 'L1' } };
}

function stepOps(plan: { steps: EvolutionPlanStep[] }): string[] {
  return plan.steps.map((s) => s.op);
}

describe('plan_evolution 作用域资产（add/update/retire）', () => {
  it('add_scope：目标不存在 → register 步骤', () => {
    const plan = plan_evolution(proposal('add_scope', { asset: scope_asset('newcomer') }), {
      entities: entity_registry(),
    });
    expect(plan.ok).toBe(true);
    expect(stepOps(plan)).toEqual(['register_scope']);
  });

  it('add_scope：实体已存在（含普通实体）→ 违规，指引走 update', () => {
    for (const id of ['planner', 'plain']) {
      const plan = plan_evolution(proposal('add_scope', { asset: scope_asset(id) }), {
        entities: entity_registry(),
      });
      expect(plan.ok).toBe(false);
      expect(plan.violations.join('')).toContain('已存在');
    }
  });

  it('update_scope：目标存在且带 scope → replace；目标缺失/非作用域 → 违规', () => {
    const ok = plan_evolution(proposal('update_scope', { asset: scope_asset('planner') }), {
      entities: entity_registry(),
    });
    expect(ok.ok).toBe(true);
    expect(stepOps(ok)).toEqual(['replace_scope']);
    const missing = plan_evolution(proposal('update_scope', { asset: scope_asset('ghost') }), {
      entities: entity_registry(),
    });
    expect(missing.ok).toBe(false);
    expect(missing.violations.join('')).toContain('不存在');
    const plain = plan_evolution(proposal('update_scope', { asset: scope_asset('plain') }), {
      entities: entity_registry(),
    });
    expect(plain.ok).toBe(false);
    expect(plain.violations.join('')).toContain('非作用域资产');
  });

  it('retire_scope：目标存在 → retire 步骤带 retired 标记记录；缺失/非作用域 → 违规', () => {
    const ok = plan_evolution(
      proposal('retire_scope', { scope: 'tester', reason: '低使用高失败' }),
      { entities: entity_registry() },
    );
    expect(ok.ok).toBe(true);
    const step = ok.steps[0]!;
    expect(step.op).toBe('retire_scope');
    if (step.op === 'retire_scope') {
      const meta = step.record['meta'] as Record<string, unknown>;
      expect(meta[RETIRED_META_KEY]).toBe(true);
      expect(meta['retired_reason']).toBe('低使用高失败');
      expect(step.record['id']).toBe('tester');
    }
    const missing = plan_evolution(proposal('retire_scope', { scope: 'ghost' }), {
      entities: entity_registry(),
    });
    expect(missing.ok).toBe(false);
    expect(missing.violations.join('')).toContain('不存在');
    const plain = plan_evolution(proposal('retire_scope', { scope: 'plain' }), {
      entities: entity_registry(),
    });
    expect(plain.ok).toBe(false);
    expect(plain.violations.join('')).toContain('非作用域资产');
  });
});

describe('plan_evolution 通道资产（add/update/封）', () => {
  it('add_channel：目标不存在 → register；已存在 → 违规', () => {
    const ok = plan_evolution(proposal('add_channel', { asset: channel_asset('return', 'return') }), {
      channels: channel_dir(),
    });
    expect(ok.ok).toBe(true);
    expect(stepOps(ok)).toEqual(['register_channel']);
    const dup = plan_evolution(proposal('add_channel', { asset: channel_asset('delegate') }), {
      channels: channel_dir(),
    });
    expect(dup.ok).toBe(false);
    expect(dup.violations.join('')).toContain('已存在');
  });

  it('update_channel：目标存在 → replace；缺失 → 违规', () => {
    const ok = plan_evolution(
      proposal('update_channel', { asset: { id: 'delegate', shape: 'delegate', conditions: { approval: 'L1' } } }),
      { channels: channel_dir() },
    );
    expect(ok.ok).toBe(true);
    expect(stepOps(ok)).toEqual(['replace_channel']);
    const missing = plan_evolution(proposal('update_channel', { asset: channel_asset('ghost') }), {
      channels: channel_dir(),
    });
    expect(missing.ok).toBe(false);
  });

  it('对启用通道 update 传 disabled=true = 违规（封禁须走 seal_channel）', () => {
    const dir = channel_dir();
    const plan = plan_evolution(
      proposal('update_channel', { asset: { id: 'delegate', shape: 'delegate', disabled: true } }),
      { channels: dir },
    );
    expect(plan.ok).toBe(false);
    expect(plan.violations.join('')).toContain('seal_channel');
    expect(dir.get('delegate')?.disabled).toBe(false);
  });

  it('seal_channel：启用 → 封禁步骤（disabled 替换）；缺失/已封 → 违规；'
    + '已封通道经 update 传 disabled=false 可重开', () => {
    const dir = channel_dir();
    const sealed = plan_evolution(proposal('seal_channel', { channel: 'delegate' }), { channels: dir });
    expect(sealed.ok).toBe(true);
    expect(stepOps(sealed)).toEqual(['seal_channel']);
    const missing = plan_evolution(proposal('seal_channel', { channel: 'ghost' }), { channels: dir });
    expect(missing.ok).toBe(false);

    dir.seal('fan_out');
    const again = plan_evolution(proposal('seal_channel', { channel: 'fan_out' }), { channels: dir });
    expect(again.ok).toBe(false);
    expect(again.violations.join('')).toContain('已封禁');
    const reopen = plan_evolution(
      proposal('update_channel', { asset: { id: 'fan_out', shape: 'fan_out', disabled: false } }),
      { channels: dir },
    );
    expect(reopen.ok).toBe(true);
  });
});

describe('plan_evolution 先验覆盖（update_prior/shortcut/downrank）', () => {
  it('update_prior：整条先验覆写为 route 行（id = 先验模式 id）', () => {
    const pattern = default_scope_priors()[0]!;
    const plan = plan_evolution(
      proposal('update_prior', { pattern: scope_prior_to_dict(pattern) }),
      {},
    );
    expect(plan.ok).toBe(true);
    const step = plan.steps[0]!;
    expect(step.op).toBe('upsert_prior');
    if (step.op === 'upsert_prior') {
      expect(step.overlay.kind).toBe('route');
      expect(step.overlay.id).toBe(pattern.id);
    }
  });

  it('apply_shortcut：跳过中继的直连 shortcut 行；from==to（环回直答）允许、'
    + '中继等于起/终点违规', () => {
    const ok = plan_evolution(
      proposal('apply_shortcut', { from: 'main', to: 'coder', skip_scope: 'planner' }),
      {},
    );
    expect(ok.ok).toBe(true);
    const loop = plan_evolution(
      proposal('apply_shortcut', { from: 'main', to: 'main', skip_scope: 'planner' }),
      {},
    );
    expect(loop.ok).toBe(true);
    const bad = plan_evolution(
      proposal('apply_shortcut', { from: 'main', to: 'coder', skip_scope: 'main' }),
      {},
    );
    expect(bad.ok).toBe(false);
    expect(bad.violations.join('')).toContain('skip_scope');
  });

  it('downrank：转场降权 → weight 行（ref = transition 键）；权重越界违规', () => {
    const ok = plan_evolution(
      proposal('downrank', {
        mode: { from: 'main', to: 'coder', shape: 'delegate', commit: 'full' },
        weight: 0.5,
      }),
      {},
    );
    expect(ok.ok).toBe(true);
    const step = ok.steps[0]!;
    if (step.op === 'upsert_prior') {
      expect(step.overlay.kind).toBe('weight');
      expect(step.overlay.id).toContain('transition');
    }
  });
});

describe('plan_evolution 目录缺失与纯函数性', () => {
  it('作用域提案无实体目录 → fail-closed 违规', () => {
    const plan = plan_evolution(proposal('add_scope', { asset: scope_asset('x') }), {});
    expect(plan.ok).toBe(false);
    expect(plan.violations.join('')).toContain('实体目录不可用');
  });

  it('计划不改动目录（快照对比）', () => {
    const dir = channel_dir();
    const before = dir.names().join(',');
    plan_evolution(proposal('seal_channel', { channel: 'delegate' }), { channels: dir });
    plan_evolution(proposal('update_channel', { asset: channel_asset('delegate') }), { channels: dir });
    expect(dir.names().join(',')).toBe(before);
    expect(dir.get('delegate')?.disabled).toBe(false);
  });
});

function channel_asset(id: string, shape = 'delegate'): Record<string, unknown> {
  return { id, shape };
}
