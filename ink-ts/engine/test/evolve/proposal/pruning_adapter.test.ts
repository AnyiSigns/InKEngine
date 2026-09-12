/**
 * Wave-2 择优 → 受控演化提案适配器单测（pruning_adapter.ts）。
 *
 * 覆盖映射表：
 * - shortcut → apply_shortcut（payload = from/to/skip_scope；证据/置信度随行）；
 * - downrank → downrank（mode + 降权默认权重 0.5）；
 * - retire → retire_scope（scope + 证据/理由）；
 * - keep → 不进提案（单独 keep 报告清单）；
 * - evaluate_and_adapt 端到端：组织档案 → 建议 → 受控提案（短路/降权/下架
 *   三类同时落位、证据随行、档案不被改动）。
 */

import { describe, expect, it } from 'vitest';

import { CHANNEL_COMMIT_FULL } from '../../../src/model/channels/channel_spec.js';
import type { OrgProposal } from '../../../src/evolve/observe/org_archive/pruning.js';
import { OrgArchive } from '../../../src/evolve/observe/org_archive/org_archive.js';
import {
  parse_execution_trail,
  type ExecutionTrail,
} from '../../../src/evolve/observe/org_archive/execution_trail.js';
import {
  DOWNRANK_PRIOR_WEIGHT,
  adapt_pruning_proposals,
  evaluate_and_adapt,
} from '../../../src/evolve/proposal/pruning_adapter.js';
import { PROVENANCE_ORG } from '../../../src/evolve/proposal/evolution_proposal.js';

function trail(dict: Record<string, unknown>): ExecutionTrail {
  return parse_execution_trail(dict);
}

/** main → planner(delegate) → main(return) 两跳中继链轨迹（常胜 → 短路）。 */
function relay(run_id: string): ExecutionTrail {
  return trail({
    run_id: run_id,
    parent_run_id: null,
    entry_scope: 'main',
    hops: [
      { from: 'main', to: 'planner', shape: 'delegate' },
      { from: 'planner', to: 'main', shape: 'return' },
    ],
    outcome: 'success',
  });
}

/** scope 单作用域收尾失败（低使用高失败 → 下架候选）。 */
function failing_leaf(run_id: string, scope: string): ExecutionTrail {
  return trail({
    run_id: run_id,
    parent_run_id: null,
    entry_scope: scope,
    hops: [],
    outcome: 'failure',
  });
}

/** scope→main 高失败回传（降权候选）。 */
function failing_return(run_id: string, scope: string): ExecutionTrail {
  return trail({
    run_id: run_id,
    parent_run_id: null,
    entry_scope: scope,
    hops: [{ from: scope, to: 'main', shape: 'return' }],
    outcome: 'failure',
  });
}

describe('适配器映射表', () => {
  it('shortcut → apply_shortcut：payload 含 from/to/skip_scope，证据与置信度随行', () => {
    const item: OrgProposal = {
      kind: 'shortcut',
      from: 'main',
      skip_scope: 'planner',
      to: 'coder',
      confidence: 0.75,
      evidence: {
        relay_observations: 12,
        relay_success_rate: 0.95,
        mid_terminal_ratio: 0.1,
        direct_seen: false,
        direct_observations: 0,
      },
    };
    const out = adapt_pruning_proposals([item]);
    expect(out.proposals).toHaveLength(1);
    const p = out.proposals[0]!;
    expect(p.kind).toBe('apply_shortcut');
    expect(p.provenance).toBe(PROVENANCE_ORG);
    expect(p.confidence).toBe(0.75);
    expect(p.payload).toEqual({ from: 'main', to: 'coder', skip_scope: 'planner' });
    expect(p.evidence['relay_observations']).toBe(12);
    expect(p.rationale).toContain('短路化');
    expect(p.rationale).toContain('planner');
  });

  it('downrank → downrank：mode 原样 + 降权默认权重 0.5', () => {
    const item: OrgProposal = {
      kind: 'downrank',
      mode: { from: 'coder', to: 'main', shape: 'return', commit: CHANNEL_COMMIT_FULL },
      confidence: 0.6,
      evidence: { observations: 9, failures: 6, degraded: 0, success_rate: 0.33, failure_rate: 0.67, last_seen_ms: 1 },
    };
    const out = adapt_pruning_proposals([item]);
    expect(out.proposals[0]?.kind).toBe('downrank');
    const payload = out.proposals[0]!.payload;
    expect(payload['weight']).toBe(DOWNRANK_PRIOR_WEIGHT);
    expect(payload['mode']).toEqual({ from: 'coder', to: 'main', shape: 'return', commit: 'full' });
  });

  it('retire → retire_scope：scope + 证据/理由', () => {
    const item: OrgProposal = {
      kind: 'retire',
      scope: 'planner',
      confidence: 0.8,
      evidence: { observations: 6, failures: 5, degraded: 0, success_rate: 0.17, failure_rate: 0.83, last_seen_ms: 2 },
    };
    const out = adapt_pruning_proposals([item]);
    const p = out.proposals[0]!;
    expect(p.kind).toBe('retire_scope');
    expect(p.payload).toEqual({ scope: 'planner' });
    expect(p.rationale).toContain('planner');
  });

  it('keep → 不进提案（keep 报告清单单独返回）', () => {
    const item: OrgProposal = {
      kind: 'keep',
      mode: { from: 'main', to: 'planner', shape: 'delegate', commit: CHANNEL_COMMIT_FULL },
      confidence: 0.9,
      evidence: { observations: 12, failures: 0, degraded: 0, success_rate: 1, last_seen_ms: 3 },
    };
    const out = adapt_pruning_proposals([item]);
    expect(out.proposals).toHaveLength(0);
    expect(out.keeps).toHaveLength(1);
    expect(out.keeps[0]?.kind).toBe('keep');
  });
});

describe('evaluate_and_adapt 端到端', () => {
  it('档案 → 建议 → 受控提案：短路/降权/下架三类同时落位、档案不被改动', () => {
    const archive = new OrgArchive();
    for (let i = 0; i < 30; i++) archive.ingest(relay(`r${i}`), 1000 + i);
    // planner 低使用高失败（收尾 10 次 ≤ retireMaxUsage=10，失败率 100%）
    for (let i = 0; i < 10; i++) archive.ingest(failing_leaf(`f${i}`, 'planner'), 2000 + i);
    // coder→main 高失败回传（10 次全败 → 降权候选）
    for (let i = 0; i < 10; i++) archive.ingest(failing_return(`d${i}`, 'coder'), 3000 + i);
    const before = archive.ingested_count();
    const out = evaluate_and_adapt(archive, { directory_scopes: ['main', 'planner', 'coder'] });
    expect(archive.ingested_count()).toBe(before);
    const kinds = out.proposals.map((p) => p.kind);
    expect(kinds).toContain('apply_shortcut');
    expect(kinds).toContain('downrank');
    expect(kinds).toContain('retire_scope');
    for (const p of out.proposals) {
      expect(p.provenance).toBe(PROVENANCE_ORG);
      expect(p.confidence).toBeGreaterThan(0);
      expect(p.evidence).not.toEqual({});
    }
    const shortcut = out.proposals.find((p) => p.kind === 'apply_shortcut');
    expect(shortcut?.payload).toEqual({ from: 'main', to: 'main', skip_scope: 'planner' });
  });
});
