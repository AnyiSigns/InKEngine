/**
 * 临时协作结晶评估器单测（crystallize.ts：sighting 聚合 → 阈值判定 → add_scope
 * 提案 + 受控通道全链）。
 *
 * 测什么：
 * - 阈值边界：最少 sighting 次数（4 不产 / 5 恰达标产出）、最低成功率（0.79 不产 /
 *   0.80 达标）、degraded 记账入分母不入分子（4成功+1降级 = 0.8 过；3+失败+降级不
 *   过）、times 加权与非法 times 回退；
 * - 模式分组：同 role 不同 model 引用拆为不同模式（各自独立统计/独立资产 id）；
 *   同模式取最新一条 def（persona 后写覆盖）；
 * - 目录感知：目录现状命中目标 id = already_registered；同批 slug 撞名 =
 *   id_conflict（先现者优先）；asset id slug 规则与 48 字符截断；
 * - 证据摘要：proposal.evidence 全字段（计数/成功率/阈值回显/sample_run_ids
 *   滚动上限 8）；提案 kind/provenance/confidence/rationale；to_dict/from_dict
 *   round-trip 恒等；
 * - 非法输入：畸形记录（非 dict / 缺 role / outcome 非法）记 malformed 跳过不
 *   抛错；定义摘要无法构造合法资产（能力 class 非法）记 asset_invalid；
 * - 选项覆写与非法值回退缺省；
 * - gate 强制试跑：评估产出的提案经既有 adoption_gate 判定 = org_pruning 新增
 *   来源强制先闸；seam pass 放行 / fail 阻断（fail-closed）；
 * - 全链 round-trip 落库：过闸（假 seam）→ 审批直过 → ControlledEvolutionApplier
 *   注册表换入 + entities 集合落盘，且落库后再评估同批 sighting = already_registered。
 */
import { describe, expect, it } from 'vitest';

import type { InterruptPolicy } from '../../../src/kernel/approval/approval_types.js';
import { DefaultEvolutionWriter } from '../../../src/kernel/evolution_writer/evolution_writer.js';
import { ChannelDirectory } from '../../../src/core/channels/channel_directory.js';
import { EntityRegistry } from '../../../src/core/entities/entities.js';
import {
  classify_gate_requirement,
  run_adoption_gate,
  type TrialRunner,
} from '../../../src/core/controlled_evolution/adoption_gate.js';
import { ControlledEvolutionApplier } from '../../../src/core/controlled_evolution/controlled_applier.js';
import {
  CRYSTALLIZE_ID_PREFIX,
  CRYSTALLIZE_MIN_SIGHTINGS,
  CRYSTALLIZE_MIN_SUCCESS_RATE,
  crystallize_asset_id,
  evaluate_temp_sightings,
  normalize_temp_sighting,
  type CrystallizeEvaluation,
} from '../../../src/core/controlled_evolution/crystallize.js';
import { EvolutionProposal } from '../../../src/core/controlled_evolution/evolution_proposal.js';
import { MemStore } from '../../kernel/evolution_writer/evolution_writer.test.js';

const AUTO_POLICY: InterruptPolicy = { should_approve: () => false, timeout_for: () => null };
const SEAM_PASS: TrialRunner = { run_trial: async () => 'pass' };
const SEAM_FAIL: TrialRunner = { run_trial: async () => 'fail' };

class StubCtx {
  async interrupt(): Promise<unknown> {
    return 'accept';
  }
}

function def(role: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { role, persona: `${role} 临时人格`, ...extra };
}

function sighting(
  role: string,
  outcome: string,
  times = 1,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { role, def: def(role), outcome, times, ...extra };
}

function repeated(role: string, n: number, outcome = 'success'): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => sighting(role, outcome, 1, { run_id: `collab:${i}:1` }));
}

describe('阈值判定（命名常量的边界语义）', () => {
  it('缺省常量：5 次 / 0.8 成功率', () => {
    expect(CRYSTALLIZE_MIN_SIGHTINGS).toBe(5);
    expect(CRYSTALLIZE_MIN_SUCCESS_RATE).toBe(0.8);
  });

  it('4 次全成功不达标（below_min_sightings）；5 次恰达标产出提案', () => {
    const below = evaluate_temp_sightings(repeated('debater', 4));
    expect(below.proposals).toHaveLength(0);
    expect(below.patterns[0]!.reason).toContain('below_min_sightings');
    const at = evaluate_temp_sightings(repeated('debater', 5));
    expect(at.proposals).toHaveLength(1);
    expect(at.patterns[0]!.status).toBe('proposed');
  });

  it('成功率边界：4/5=0.80 达标；7 成 3 败 = 0.70 不达标（below_success_rate）', () => {
    const pass = evaluate_temp_sightings(
      [...repeated('debater', 4), sighting('debater', 'failure')],
    );
    expect(pass.proposals).toHaveLength(1);
    const fail = evaluate_temp_sightings([
      ...repeated('debater', 7),
      ...repeated('debater', 3, 'failure'),
    ]);
    expect(fail.proposals).toHaveLength(0);
    expect(fail.patterns[0]!.reason).toContain('below_success_rate');
    expect(fail.patterns[0]!.success_rate).toBe(0.7);
  });

  it('degraded 计入分母不入分子：4成功+1降级 = 0.8 过；3成功+1败+1降级 = 0.6 不过', () => {
    const ok = evaluate_temp_sightings(
      [...repeated('debater', 4), sighting('debater', 'degraded')],
    );
    expect(ok.proposals).toHaveLength(1);
    expect(ok.patterns[0]!.degraded).toBe(1);
    const bad = evaluate_temp_sightings(
      [
        ...repeated('debater', 3),
        sighting('debater', 'failure'),
        sighting('debater', 'degraded'),
      ],
    );
    expect(bad.proposals).toHaveLength(0);
  });

  it('times 加权（一条 times=5 的常胜行达标；非法 times 回退 1）', () => {
    const weighted = evaluate_temp_sightings([sighting('debater', 'success', 5)]);
    expect(weighted.proposals).toHaveLength(1);
    expect(weighted.patterns[0]!.sightings).toBe(5);
    const badTimes = normalize_temp_sighting(sighting('debater', 'success', -3));
    expect(badTimes?.times).toBe(1);
  });

  it('选项覆写阈值生效；非法覆写值（0/负数/超 1 成功率）回退缺省', () => {
    const relaxed = evaluate_temp_sightings(repeated('debater', 2), null, {
      min_sightings: 2,
      min_success_rate: 0.5,
    });
    expect(relaxed.proposals).toHaveLength(1);
    const junk = evaluate_temp_sightings(repeated('debater', 5), null, {
      min_sightings: 0,
      min_success_rate: 5,
    });
    expect(junk.proposals).toHaveLength(1);
    const thresholds = junk.proposals[0]!.evidence['thresholds'] as Record<string, unknown>;
    expect(thresholds['min_sightings']).toBe(CRYSTALLIZE_MIN_SIGHTINGS);
    expect(thresholds['min_success_rate']).toBe(CRYSTALLIZE_MIN_SUCCESS_RATE);
  });
});

describe('模式分组与 def 聚合', () => {
  it('同 role 不同 model 引用 = 不同模式（各自统计与独立资产 id）', () => {
    const rows = [
      ...repeated('analyst', 5),
      ...Array.from({ length: 5 }, (_, i) =>
        sighting('analyst', 'success', 1, {
          def: def('analyst', { model: { provider: 'p1', model_id: 'm1' } }),
          run_id: `r${i}`,
        }),
      ),
    ];
    const result = evaluate_temp_sightings(rows);
    expect(result.proposals).toHaveLength(2);
    const ids = result.proposals.map((p) => (p.payload['asset'] as Record<string, unknown>)['id']);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(`${CRYSTALLIZE_ID_PREFIX}analyst@p1-m1`);
  });

  it('同模式取最新 def（persona/label 后写覆盖进资产）', () => {
    const result = evaluate_temp_sightings([
      ...repeated('debater', 4),
      { role: 'debater', def: { role: 'debater', persona: '新人格', label: '辩论者' }, outcome: 'success' },
    ]);
    const asset = result.proposals[0]!.payload['asset'] as Record<string, unknown>;
    expect(asset['persona']).toBe('新人格');
    expect(asset['label']).toBe('辩论者');
  });
});

describe('目录感知与 id 规则', () => {
  it('slug 资产 id；超长截断到实体 id 上限（≤48）', () => {
    expect(crystallize_asset_id('Deep Think', null, 'crystal:')).toBe('crystal:deep-think');
    const long = crystallize_asset_id('角'.repeat(60), null, CRYSTALLIZE_ID_PREFIX);
    expect(long.length).toBeLessThanOrEqual(48);
  });

  it('目录现状命中目标 id = already_registered；同批 slug 撞名 = id_conflict', () => {
    const rows5 = repeated('debater', 5);
    const dup = evaluate_temp_sightings([...rows5, ...repeated('Debater', 5)]);
    expect(dup.proposals).toHaveLength(1);
    expect((dup.proposals[0]!.payload['asset'] as Record<string, unknown>)['id']).toBe('crystal:debater');
    expect(dup.patterns.some((p) => p.reason.includes('id_conflict'))).toBe(true);
    const after = evaluate_temp_sightings(rows5, { entity_ids: ['crystal:debater'] });
    expect(after.proposals).toHaveLength(0);
    expect(after.patterns[0]!.reason).toContain('already_registered');
  });
});

describe('非法输入与资产构造失败（评估器永不抛错）', () => {
  it('非 dict / 缺 role / outcome 非法 → malformed 跳过，其余模式照常产出', () => {
    const result = evaluate_temp_sightings(
      ['nope', { outcome: 'success' }, sighting('debater', 'explode'), ...repeated('debater', 5)],
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.patterns.filter((p) => p.reason === 'malformed')).toHaveLength(3);
  });

  it('定义摘要非法（能力 class 越词表）→ asset_invalid 记录，不抛错', () => {
    const rows = Array.from({ length: 5 }, () => ({
      role: 'debater',
      def: { role: 'debater', capabilities: [{ id: 'x', class: 'magic' }] },
      outcome: 'success',
    }));
    const result = evaluate_temp_sightings(rows);
    expect(result.proposals).toHaveLength(0);
    expect(result.patterns[0]!.reason).toContain('asset_invalid');
  });
});

describe('提案形态与证据摘要', () => {
  const rows = [
    ...repeated('debater', 4),
    ...Array.from({ length: 10 }, (_, i) => sighting('debater', 'success', 1, { run_id: `r${i}` })),
  ];
  const evaluation = evaluate_temp_sightings(rows.slice(0, 14));

  it('add_scope + org_pruning 提案：confidence = 成功率；rationale 可读', () => {
    const p = evaluation.proposals[0]!;
    expect(p.kind).toBe('add_scope');
    expect(p.provenance).toBe('org_pruning');
    expect(p.confidence).toBe(1);
    expect(p.rationale).toContain('临时协作结晶');
    expect(p.rationale).toContain('crystal:debater');
  });

  it('证据摘要全字段 + sample_run_ids 滚动上限 8（留最新）', () => {
    const many = evaluate_temp_sightings(
      Array.from({ length: 10 }, (_, i) => sighting('debater', 'success', 1, { run_id: `r${i}` })),
    );
    const e = many.proposals[0]!.evidence;
    expect(e['source']).toBe('temp_sightings');
    expect(e['role']).toBe('debater');
    expect(e['sightings']).toBe(10);
    expect(e['success']).toBe(10);
    expect(e['success_rate']).toBe(1);
    expect((e['thresholds'] as Record<string, unknown>)['min_sightings']).toBe(5);
    const samples = e['sample_run_ids'] as string[];
    expect(samples).toHaveLength(8);
    expect(samples[7]).toBe('r9');
    expect(samples[0]).toBe('r2');
  });

  it('提案 to_dict/from_dict round-trip 恒等；资产可回 EntitySpec 装载', () => {
    const p = evaluation.proposals[0]!;
    const back = EvolutionProposal.from_dict(JSON.parse(JSON.stringify(p.to_dict())));
    expect(back.to_dict()).toEqual(p.to_dict());
    const asset = back.payload['asset'] as Record<string, unknown>;
    expect(asset['role']).toBe('debater');
    expect((asset['scope'] as Record<string, unknown>)['guard_level']).toBe('L1');
  });
});

describe('gate 强制试跑 + 受控通道全链落库', () => {
  function rig() {
    const store = new MemStore();
    const registry = new EntityRegistry();
    const channels = new ChannelDirectory();
    const applier = new ControlledEvolutionApplier({
      entities: registry,
      channels,
      writer: new DefaultEvolutionWriter(store),
      approvalPolicy: AUTO_POLICY,
    });
    return { store, registry, channels, applier };
  }

  it('结晶提案经既有闸判定：org_pruning 新增 = 强制先闸；无执行器/试跑失败均 fail-closed', async () => {
    const p = evaluate_temp_sightings(repeated('debater', 5)).proposals[0]!;
    expect(classify_gate_requirement(p).required).toBe(true);
    const noSeam = await run_adoption_gate(p, {});
    expect(noSeam.blocked).toBe(true);
    const failed = await run_adoption_gate(p, { seam: SEAM_FAIL });
    expect(failed.blocked).toBe(true);
    expect(failed.verdict).toBe('fail');
    const passed = await run_adoption_gate(p, { seam: SEAM_PASS });
    expect(passed.blocked).toBe(false);
  });

  it('applier 全链（seam pass + 审批直过）：applied=注册表换入+集合落盘；再评估=already_registered', async () => {
    const r = rig();
    const p = evaluate_temp_sightings(repeated('debater', 5)).proposals[0]!;
    const report = await r.applier.apply(new StubCtx(), p, { trialRunner: SEAM_PASS });
    expect(report.status).toBe('applied');
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.verdict).toBe('pass');
    expect(r.registry.get('crystal:debater')?.role).toBe('debater');
    expect(r.store.records.get('entities:-')?.get('crystal:debater')?.['id']).toBe('crystal:debater');
    const again: CrystallizeEvaluation = evaluate_temp_sightings(repeated('debater', 5), {
      entity_ids: r.registry.names(),
    });
    expect(again.proposals).toHaveLength(0);
    expect(again.patterns[0]!.reason).toContain('already_registered');
  });

  it('applier 无试跑执行器：org_pruning 结晶提案被闸挡下（gate_blocked 零副作用）', async () => {
    const r = rig();
    const p = evaluate_temp_sightings(repeated('debater', 5)).proposals[0]!;
    const report = await r.applier.apply(new StubCtx(), p);
    expect(report.status).toBe('gate_blocked');
    expect(r.registry.get('crystal:debater')).toBeNull();
    expect(r.store.records.get('entities:-')?.size ?? 0).toBe(0);
  });
});
