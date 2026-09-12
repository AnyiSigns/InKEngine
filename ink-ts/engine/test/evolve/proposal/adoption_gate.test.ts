/**
 * 采纳前验证闸单测（adoption_gate.ts：闸线判定 + 试跑 seam + fail-closed）。
 *
 * 覆盖：
 * - 强制闸线：既有资产变更类（update/retire/封/先验/短路/降权）一律强制；
 *   新增类仅非 user 来源（agent_self/org_pruning）强制，user 直接进审批；
 * - trial_spec_for：试跑规格携带变更意图 + 证据（试跑证据不进主档案）；
 * - run_adoption_gate 数据流：非强制放行不调 seam；强制 + 未装配 seam =
 *   fail-closed 阻断；强制 + seam pass 放行、fail/inconclusive 阻断；
 * - verdict_blocks：只有 pass 放行（inconclusive 视同失败）。
 */

import { describe, expect, it } from 'vitest';

import {
  GATE_ADDITIVE_KINDS,
  GATE_MANDATORY_KINDS,
  classify_gate_requirement,
  run_adoption_gate,
  trial_spec_for,
  verdict_blocks,
  type TrialRunner,
} from '../../../src/evolve/proposal/adoption_gate.js';
import {
  PROVENANCE_AGENT,
  PROVENANCE_ORG,
  PROVENANCE_USER,
  EvolutionProposal,
  type EvolutionProposalKind,
  type EvolutionProvenance,
} from '../../../src/evolve/proposal/evolution_proposal.js';

function p(
  kind: EvolutionProposalKind,
  provenance: EvolutionProvenance = PROVENANCE_USER,
  evidence = {},
): EvolutionProposal {
  const payloads: Record<string, Record<string, unknown>> = {
    add_scope: { asset: { id: 'x', scope: { guard_level: 'L1' } } },
    update_scope: { asset: { id: 'x', scope: { guard_level: 'L1' } } },
    retire_scope: { scope: 'x' },
    add_channel: { asset: { id: 'c', shape: 'delegate' } },
    update_channel: { asset: { id: 'c', shape: 'delegate' } },
    seal_channel: { channel: 'c' },
    update_prior: { pattern: { id: 'x' } },
    apply_shortcut: { from: 'a', to: 'b', skip_scope: 'r' },
    downrank: { mode: { from: 'a', to: 'b', shape: 'delegate', commit: 'full' }, weight: 0.5 },
  };
  return new EvolutionProposal({
    kind,
    payload: payloads[kind]!,
    provenance,
    evidence,
    rationale: 'test',
  });
}

describe('闸线判定 classify_gate_requirement', () => {
  it('既有资产变更类一律强制先闸（九种中七种）', () => {
    expect(GATE_MANDATORY_KINDS).toEqual([
      'update_scope',
      'retire_scope',
      'update_channel',
      'seal_channel',
      'update_prior',
      'apply_shortcut',
      'downrank',
    ]);
    for (const kind of GATE_MANDATORY_KINDS) {
      const requirement = classify_gate_requirement(p(kind));
      expect(requirement.required).toBe(true);
      expect(requirement.reasons.length).toBeGreaterThan(0);
    }
  });

  it('新增类（add_scope/add_channel）：user 不强制（全量审批即直放），'
    + 'agent_self/org_pruning 强制先闸', () => {
    expect(GATE_ADDITIVE_KINDS).toEqual(['add_scope', 'add_channel']);
    for (const kind of GATE_ADDITIVE_KINDS) {
      expect(classify_gate_requirement(p(kind, PROVENANCE_USER)).required).toBe(false);
      expect(classify_gate_requirement(p(kind, PROVENANCE_AGENT)).required).toBe(true);
      expect(classify_gate_requirement(p(kind, PROVENANCE_ORG)).required).toBe(true);
    }
  });

  it('mandatoryKinds 可覆写（收紧）；agent 新增强制理由指明来源', () => {
    const overridden = classify_gate_requirement(p('add_scope', PROVENANCE_AGENT), {
      mandatoryKinds: GATE_MANDATORY_KINDS,
    });
    expect(overridden.required).toBe(true);
    expect(overridden.reasons.join('')).toContain('agent_self');
  });
});

describe('trial_spec_for 与 verdict_blocks', () => {
  it('试跑规格 = 提案变更意图 + 证据（payload 副本）', () => {
    const proposal = p('apply_shortcut', PROVENANCE_ORG, { relay_observations: 10 });
    const spec = trial_spec_for(proposal);
    expect(spec.kind).toBe('apply_shortcut');
    expect(spec.payload).toEqual({ from: 'a', to: 'b', skip_scope: 'r' });
    expect(spec.evidence).toEqual({ relay_observations: 10 });
    expect(spec.confidence).toBeNull();
  });

  it('只有 pass 放行；fail/inconclusive 同判阻断（fail-closed）', () => {
    expect(verdict_blocks('pass')).toBe(false);
    expect(verdict_blocks('fail')).toBe(true);
    expect(verdict_blocks('inconclusive')).toBe(true);
  });
});

describe('run_adoption_gate 数据流', () => {
  function seamWith(verdict: 'pass' | 'fail' | 'inconclusive'): TrialRunner {
    return { run_trial: async () => verdict };
  }

  it('非强制提案：直接放行（不进试跑，不调 seam）', async () => {
    let called = 0;
    const seam: TrialRunner = { run_trial: async () => { called += 1; return 'pass'; } };
    const outcome = await run_adoption_gate(p('add_scope', PROVENANCE_USER), { seam });
    expect(outcome.required).toBe(false);
    expect(outcome.blocked).toBe(false);
    expect(outcome.spec).toBeNull();
    expect(called).toBe(0);
  });

  it('强制 + 未装配 seam = fail-closed 阻断（缺执行器，不得裸奔上线）', async () => {
    const outcome = await run_adoption_gate(p('retire_scope', PROVENANCE_USER), { seam: null });
    expect(outcome.required).toBe(true);
    expect(outcome.blocked).toBe(true);
    expect(outcome.verdict).toBeNull();
    expect(outcome.block_reason).toContain('fail-closed');
  });

  it('强制 + seam pass → 放行过闸', async () => {
    const outcome = await run_adoption_gate(p('apply_shortcut', PROVENANCE_ORG), {
      seam: seamWith('pass'),
    });
    expect(outcome.required).toBe(true);
    expect(outcome.blocked).toBe(false);
    expect(outcome.verdict).toBe('pass');
    expect(outcome.spec?.kind).toBe('apply_shortcut');
  });

  it('强制 + seam fail/inconclusive → 阻断（试跑胜负不进主执行证据）', async () => {
    for (const verdict of ['fail', 'inconclusive'] as const) {
      const outcome = await run_adoption_gate(p('downrank', PROVENANCE_ORG), {
        seam: seamWith(verdict),
      });
      expect(outcome.blocked).toBe(true);
      expect(outcome.block_reason).toContain(verdict);
    }
  });
});
