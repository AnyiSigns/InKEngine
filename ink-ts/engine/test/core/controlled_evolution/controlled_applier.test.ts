/**
 * 受控演化应用层单测（controlled_applier.ts：闸 → 审批 → 受控写入编排）。
 *
 * 覆盖：
 * - 作用域资产新增/下架经受控通道落位（writer 持久化 + 活跃注册表换入；
 *   下架 = retired 记录写盘 + 活跃表移除）；
 * - 通道封禁：disabled 记录落盘 + 目录 replace；
 * - 先验覆盖（downrank）经 org_priors 集合落盘（无活跃目录可换）；
 * - 采纳前验证闸前置：高影响提案（retire_scope）无试跑执行器 = fail-closed
 *   阻断，不触发审批、零副作用；
 * - 审批否决（注入 reject）= 不应用任何步骤（闸过后审批仍是闸门）；
 * - 计划校验非法（重复新增）= invalid，零写入。
 */

import { describe, expect, it } from 'vitest';

import type { InterruptPolicy } from '../../../src/kernel/approval/approval_types.js';
import { DefaultEvolutionWriter } from '../../../src/kernel/evolution_writer/evolution_writer.js';
import { ChannelSpec } from '../../../src/core/channels/channel_spec.js';
import { ChannelDirectory } from '../../../src/core/channels/channel_directory.js';
import { EntityRegistry, EntitySpec, RETIRED_META_KEY } from '../../../src/core/entities/entities.js';
import {
  PROVENANCE_ORG,
  PROVENANCE_USER,
  EvolutionProposal,
} from '../../../src/core/controlled_evolution/evolution_proposal.js';
import { ControlledEvolutionApplier } from '../../../src/core/controlled_evolution/controlled_applier.js';
import type { TrialRunner } from '../../../src/core/controlled_evolution/adoption_gate.js';
import { MemStore } from '../../kernel/evolution_writer/evolution_writer.test.js';

/** 审批直过策略（auto：全部免挂，供「闸 → 审批直过 → 落盘」主路径）。 */
const AUTO_POLICY: InterruptPolicy = {
  should_approve: () => false,
  timeout_for: () => null,
};

/** 注入决议上下文（默认 reject，验证审批否决路径）。 */
class StubCtx {
  decision: unknown = 'reject';
  async interrupt(): Promise<unknown> {
    return this.decision;
  }
}

/** 试跑执行器桩（pass = 过闸）。 */
const SEAM_PASS: TrialRunner = { run_trial: async () => 'pass' };

function scope_spec(id: string): EntitySpec {
  return new EntitySpec({ id, role: id, scope: { guard_level: 'L1' } });
}

function proposal(kind: string, payload: Record<string, unknown>, provenance: string): EvolutionProposal {
  return new EvolutionProposal({
    kind: kind as never,
    payload,
    provenance: provenance as never,
    confidence: provenance === 'org_pruning' ? 0.7 : undefined,
    rationale: `test ${kind}`,
  });
}

interface Rig {
  store: MemStore;
  registry: EntityRegistry;
  channels: ChannelDirectory;
}

function rig(): Rig {
  const registry = new EntityRegistry();
  registry.register(scope_spec('planner'));
  registry.register(scope_spec('tester'));
  const channels = new ChannelDirectory();
  channels.register(new ChannelSpec({ id: 'delegate', shape: 'delegate' }));
  return { store: new MemStore(), registry, channels };
}

function applierFor(rig: Rig, extra: Partial<ConstructorParameters<typeof ControlledEvolutionApplier>[0]> = {}): ControlledEvolutionApplier {
  return new ControlledEvolutionApplier({
    entities: rig.registry,
    channels: rig.channels,
    writer: new DefaultEvolutionWriter(rig.store),
    approvalPolicy: AUTO_POLICY,
    ...extra,
  });
}

describe('作用域资产经受控通道落位', () => {
  it('add_scope（user + 审批直过）→ applied：注册表新增 + entities 集合落盘', async () => {
    const r = rig();
    const applier = applierFor(r);
    const p = proposal(
      'add_scope',
      { asset: { id: 'newcomer', role: 'coder', scope: { guard_level: 'L1' } } },
      PROVENANCE_USER,
    );
    const report = await applier.apply(new StubCtx() as never, p);
    expect(report.status).toBe('applied');
    expect(report.steps_applied).toBe(1);
    expect(r.registry.get('newcomer')?.role).toBe('coder');
    expect(r.store.records.get('entities:-')?.get('newcomer')?.['id']).toBe('newcomer');
  });

  it('retire_scope（强制闸 → seam pass → 审批直过）→ applied：retired 记录落盘 + 活跃表移除', async () => {
    const r = rig();
    const applier = applierFor(r, { trialRunner: SEAM_PASS });
    const p = proposal('retire_scope', { scope: 'tester', reason: '择优下架' }, PROVENANCE_ORG);
    const report = await applier.apply(new StubCtx() as never, p);
    expect(report.status).toBe('applied');
    expect(r.registry.get('tester')).toBeNull();
    const row = r.store.records.get('entities:-')?.get('tester');
    const meta = row?.['meta'] as Record<string, unknown> | undefined;
    expect(meta?.[RETIRED_META_KEY]).toBe(true);
    expect(meta?.['retired_reason']).toBe('择优下架');
  });

  it('重复新增（目标已存在）= invalid：零写入、目录原样', async () => {
    const r = rig();
    const applier = applierFor(r);
    const p = proposal('add_scope', { asset: { id: 'planner', role: 'planner', scope: { guard_level: 'L1' } } }, PROVENANCE_USER);
    const report = await applier.apply(new StubCtx() as never, p);
    expect(report.status).toBe('invalid');
    expect(report.violations.join('')).toContain('已存在');
    expect(r.registry.get('planner')?.role).toBe('planner');
  });
});

describe('通道封禁与先验覆盖落位', () => {
  it('seal_channel（强制闸 → seam pass）→ applied：disabled 记录落盘 + 活跃目录 replace', async () => {
    const r = rig();
    const applier = applierFor(r, { trialRunner: SEAM_PASS });
    const p = proposal('seal_channel', { channel: 'delegate' }, PROVENANCE_USER);
    const report = await applier.apply(new StubCtx() as never, p);
    expect(report.status).toBe('applied');
    expect(r.channels.get('delegate')?.disabled).toBe(true);
    const row = r.store.records.get('channels:-')?.get('delegate');
    expect((row as Record<string, unknown>)?.['disabled']).toBe(true);
  });

  it('downrank（org_pruning）→ applied：org_priors 集合落 weight 行', async () => {
    const r = rig();
    const applier = applierFor(r, { trialRunner: SEAM_PASS });
    const p = proposal(
      'downrank',
      { mode: { from: 'main', to: 'coder', shape: 'delegate', commit: 'full' }, weight: 0.5 },
      PROVENANCE_ORG,
    );
    const report = await applier.apply(new StubCtx() as never, p);
    expect(report.status).toBe('applied');
    const rows = [...(r.store.records.get('org_priors:-')?.values() ?? [])];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row['kind']).toBe('weight');
    expect(row['weight']).toBe(0.5);
    expect(String(row['id'])).toContain('transition');
  });
});

describe('采纳前验证闸与审批是两道前置闸门', () => {
  it('retire_scope 无试跑执行器 = gate_blocked：不触发审批、零副作用', async () => {
    const r = rig();
    const applier = applierFor(r);
    const p = proposal('retire_scope', { scope: 'tester' }, PROVENANCE_USER);
    const report = await applier.apply(new StubCtx() as never, p);
    expect(report.status).toBe('gate_blocked');
    expect(report.approval).toBeNull();
    expect(r.registry.get('tester')).not.toBeNull();
    expect(r.store.records.get('entities:-')?.get('tester')).toBeUndefined();
  });

  it('闸过后审批注入 reject → approval_rejected：不应用任何步骤', async () => {
    const r = rig();
    const applier = applierFor(r, { approvalPolicy: null, trialRunner: SEAM_PASS });
    const p = proposal('retire_scope', { scope: 'tester' }, PROVENANCE_ORG);
    const ctx = new StubCtx();
    const report = await applier.apply(ctx as never, p);
    expect(report.status).toBe('approval_rejected');
    expect(report.approval?.decision).toBe('reject');
    expect(report.steps_applied).toBe(0);
    expect(r.registry.get('tester')).not.toBeNull();
    expect(r.store.records.get('entities:-')?.get('tester')).toBeUndefined();
  });

  it('闸过后审批 accept（注入）→ applied', async () => {
    const r = rig();
    const applier = applierFor(r, { approvalPolicy: null, trialRunner: SEAM_PASS });
    const p = proposal('update_scope', { asset: { id: 'planner', role: 'planner', scope: { guard_level: 'L2' } } }, PROVENANCE_USER);
    const ctx = new StubCtx();
    ctx.decision = 'accept';
    const report = await applier.apply(ctx as never, p);
    expect(report.status).toBe('applied');
    expect(r.registry.get('planner')?.scope?.guard_level).toBe('L2');
    const row = r.store.records.get('entities:-')?.get('planner');
    expect(((row?.['scope'] as Record<string, unknown>)?.['guard_level'])).toBe('L2');
  });
});
