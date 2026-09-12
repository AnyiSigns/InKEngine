/**
 * 组织档案择优判定单测（pruning.ts：阈值常量 + 建议动作规则）。
 *
 * 覆盖：
 * - 阈值常量/缺省归一（可覆写、可配置）；
 * - 置信度：随观测数相对证据下限饱和递增；
 * - 常胜短路：链模式常胜 + 中继纯过路（收尾占比低）→ 建议跳 R 直连；
 *   成功率不足 / 中继常收尾 → 不触发；中继作用域证据不足不触发；
 * - 高失败降权：failure+degraded 占比超线触发、证据不足/失败率不足不触发；
 * - 低使用高失败下架：只对目录已知作用域（缺省 = 出厂目录身份；可显式传入
 *   目录集合）、使用窗口与失败率边界不触发；
 * - 常胜保持：高使用 + 高成功 → keep 建议；
 * - evaluate_org_archive 组合输出顺序固定、同输入确定性、不改动档案（纯）。
 */

import { describe, expect, it } from 'vitest';

import { CHANNEL_COMMIT_FULL } from '../../../../src/model/channels/channel_spec.js';
import {
  parse_execution_trail,
  type ExecutionTrail,
} from '../../../../src/evolve/observe/org_archive/execution_trail.js';
import { OrgArchive } from '../../../../src/evolve/observe/org_archive/org_archive.js';
import {
  ORG_DOWNRANK_FAILURE_RATE,
  ORG_MIN_EVIDENCE,
  ORG_RETIRE_MIN_EVIDENCE,
  ORG_SHORTCUT_MIN_EVIDENCE,
  ORG_SHORTCUT_MIN_SUCCESS_RATE,
  default_pruning_thresholds,
  evaluate_org_archive,
  proposal_confidence,
  suggest_downranks,
  suggest_keeps,
  suggest_retires,
  suggest_shortcuts,
  type ShortcutProposal,
} from '../../../../src/evolve/observe/org_archive/pruning.js';

function trail(dict: Record<string, unknown>): ExecutionTrail {
  return parse_execution_trail(dict);
}

/** main → planner 委托转场。 */
function delegate(run_id: string, outcome = 'success'): ExecutionTrail {
  return trail({
    run_id: run_id,
    parent_run_id: null,
    entry_scope: 'main',
    hops: [{ from: 'main', to: 'planner', shape: 'delegate' }],
    outcome,
  });
}

/** main → planner(delegate) → main(return) 两跳链。 */
function relay(run_id: string, outcome = 'success'): ExecutionTrail {
  return trail({
    run_id: run_id,
    parent_run_id: null,
    entry_scope: 'main',
    hops: [
      { from: 'main', to: 'planner', shape: 'delegate' },
      { from: 'planner', to: 'main', shape: 'return' },
    ],
    outcome,
  });
}

/** 单作用域收尾（entry 直答；用于抬高某作用域的收尾占比）。 */
function leaf(run_id: string, scope: string, outcome = 'success'): ExecutionTrail {
  return trail({
    run_id: run_id,
    parent_run_id: null,
    entry_scope: scope,
    hops: [],
    outcome,
  });
}

function ingest_many(archive: OrgArchive, list: ExecutionTrail[], startNow = 1000): void {
  for (let i = 0; i < list.length; i++) archive.ingest(list[i]!, startNow + i);
}

describe('pruning 阈值与置信度', () => {
  it('缺省阈值 = 具名常量（可覆写）', () => {
    const t = default_pruning_thresholds();
    expect(t.minEvidence).toBe(ORG_MIN_EVIDENCE);
    expect(t.shortcutMinEvidence).toBe(ORG_SHORTCUT_MIN_EVIDENCE);
    expect(t.shortcutMinSuccessRate).toBe(ORG_SHORTCUT_MIN_SUCCESS_RATE);
    expect(t.downrankFailureRate).toBe(ORG_DOWNRANK_FAILURE_RATE);
    expect(t.retireMinEvidence).toBe(ORG_RETIRE_MIN_EVIDENCE);
  });

  it('置信度随观测数相对证据下限饱和递增（obs=min → 0.5）', () => {
    expect(proposal_confidence(0, 8)).toBe(0);
    expect(proposal_confidence(8, 8)).toBeCloseTo(0.5);
    expect(proposal_confidence(16, 8)).toBeCloseTo(2 / 3);
    expect(proposal_confidence(24, 8)).toBeCloseTo(0.75);
  });
});

describe('pruning 常胜短路建议', () => {
  it('链常胜 + 中继纯过路 → 建议跳 R 直连（证据/置信度在场）', () => {
    const archive = new OrgArchive();
    ingest_many(archive, Array.from({ length: 8 }, (_, i) => relay(`r${i}`)));
    const proposals = suggest_shortcuts(archive);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('shortcut');
    expect(p.skip_scope).toBe('planner');
    expect(p.from).toBe('main');
    expect(p.to).toBe('main');
    expect(p.confidence).toBeCloseTo(0.5);
    expect(p.evidence.relay_observations).toBe(8);
    expect(p.evidence.relay_success_rate).toBeCloseTo(1);
    expect(p.evidence.mid_terminal_ratio).toBe(0);
  });

  it('成功率不足（失败掺入）不触发短路', () => {
    const archive = new OrgArchive();
    const runs = [
      ...Array.from({ length: 6 }, (_, i) => relay(`ok${i}`, 'success')),
      ...Array.from({ length: 3 }, (_, i) => relay(`fail${i}`, 'failure')),
    ];
    ingest_many(archive, runs);
    expect(suggest_shortcuts(archive)).toEqual([]);
  });

  it('中继作用域常收尾（非纯过路）不触发短路', () => {
    const archive = new OrgArchive();
    ingest_many(archive, Array.from({ length: 8 }, (_, i) => relay(`r${i}`)));
    // planner 额外 5 次作为收尾作用域：终态占比 5/13 > 0.3
    ingest_many(archive, Array.from({ length: 5 }, (_, i) => leaf(`leaf${i}`, 'planner')));
    expect(suggest_shortcuts(archive)).toEqual([]);
  });

  it('覆写阈值允许小样本触发（可配置启发式强度）', () => {
    const archive = new OrgArchive();
    ingest_many(archive, Array.from({ length: 3 }, (_, i) => relay(`r${i}`)));
    const proposals = suggest_shortcuts(archive, {
      thresholds: { shortcutMinEvidence: 3, shortcutMinSuccessRate: 1 },
    });
    expect(proposals).toHaveLength(1);
    expect((proposals[0] as ShortcutProposal).evidence.relay_observations).toBe(3);
  });
});

describe('pruning 高失败降权建议', () => {
  it('失败+降级占比超线 → 降权建议（模式 + 证据）', () => {
    const archive = new OrgArchive();
    ingest_many(archive, Array.from({ length: 8 }, (_, i) => delegate(`f${i}`, 'failure')));
    const proposals = suggest_downranks(archive);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('downrank');
    expect(p.mode).toEqual({
      from: 'main',
      to: 'planner',
      shape: 'delegate',
      commit: CHANNEL_COMMIT_FULL,
    });
    expect(p.evidence.observations).toBe(8);
    expect(p.evidence.failures).toBe(8);
    expect(p.evidence.failure_rate).toBeCloseTo(1);
    expect(p.confidence).toBeCloseTo(0.5);
  });

  it('降级(degraded)计入失败侧信号', () => {
    const archive = new OrgArchive();
    const runs = [
      ...Array.from({ length: 4 }, (_, i) => delegate(`d${i}`, 'degraded')),
      ...Array.from({ length: 2 }, (_, i) => delegate(`f${i}`, 'failure')),
      ...Array.from({ length: 2 }, (_, i) => delegate(`s${i}`, 'success')),
    ];
    ingest_many(archive, runs);
    const proposals = suggest_downranks(archive);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.evidence.failure_rate).toBeCloseTo(0.75);
  });

  it('失败率不足 / 证据不足不触发', () => {
    const lowRate = new OrgArchive();
    ingest_many(
      lowRate,
      [
        ...Array.from({ length: 5 }, (_, i) => delegate(`s${i}`, 'success')),
        ...Array.from({ length: 3 }, (_, i) => delegate(`f${i}`, 'failure')),
      ],
    );
    expect(suggest_downranks(lowRate)).toEqual([]);
    const lowEvidence = new OrgArchive();
    ingest_many(lowEvidence, Array.from({ length: 4 }, (_, i) => delegate(`f${i}`, 'failure')));
    expect(suggest_downranks(lowEvidence)).toEqual([]);
  });
});

describe('pruning 低使用高失败下架建议', () => {
  it('目录作用域低使用 + 高失败 → 下架建议', () => {
    const archive = new OrgArchive();
    ingest_many(archive, Array.from({ length: 6 }, (_, i) => delegate(`f${i}`, 'failure')));
    const proposals = suggest_retires(archive);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('retire');
    expect(p.scope).toBe('planner');
    expect(p.evidence.observations).toBe(6);
    expect(p.evidence.failure_rate).toBeCloseTo(1);
  });

  it('默认只对目录身份作用域下架；显式目录集可扩展候选', () => {
    const archive = new OrgArchive();
    ingest_many(archive, Array.from({ length: 6 }, (_, i) => delegate(`f${i}`, 'failure')));
    const ghost = new OrgArchive();
    ingest_many(
      ghost,
      Array.from({ length: 6 }, (_, i) =>
        trail({
          run_id: `g${i}`,
          parent_run_id: null,
          entry_scope: 'main',
          hops: [{ from: 'main', to: 'ghost', shape: 'delegate' }],
          outcome: 'failure',
        })),
    );
    // planner 属出厂目录身份 → 提出；ghost 非目录 → 默认不提
    expect(suggest_retires(archive).map((p) => p.scope)).toEqual(['planner']);
    expect(suggest_retires(ghost)).toEqual([]);
    expect(suggest_retires(ghost, { directory_scopes: ['ghost'] })).toHaveLength(1);
  });

  it('使用窗口（过低/过高）或失败率不足不触发', () => {
    const tooFew = new OrgArchive();
    ingest_many(tooFew, Array.from({ length: 3 }, (_, i) => delegate(`f${i}`, 'failure')));
    expect(suggest_retires(tooFew)).toEqual([]);
    const tooMany = new OrgArchive();
    ingest_many(tooMany, Array.from({ length: 12 }, (_, i) => delegate(`f${i}`, 'failure')));
    expect(suggest_retires(tooMany)).toEqual([]);
    const lowFailure = new OrgArchive();
    ingest_many(lowFailure, Array.from({ length: 6 }, (_, i) => delegate(`s${i}`, 'success')));
    expect(suggest_retires(lowFailure)).toEqual([]);
  });
});

describe('pruning 常胜保持建议', () => {
  it('高使用 + 高成功 → keep（winner 维持/加权参照）', () => {
    const archive = new OrgArchive();
    ingest_many(archive, Array.from({ length: 10 }, (_, i) => delegate(`s${i}`)));
    const proposals = suggest_keeps(archive);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('keep');
    expect(p.mode).toEqual({
      from: 'main',
      to: 'planner',
      shape: 'delegate',
      commit: CHANNEL_COMMIT_FULL,
    });
    expect(p.evidence.success_rate).toBeCloseTo(1);
  });

  it('成功率不足不触发 keep', () => {
    const archive = new OrgArchive();
    ingest_many(
      archive,
      Array.from({ length: 10 }, (_, i) => delegate(`m${i}`, i < 2 ? 'failure' : 'success')),
    );
    expect(suggest_keeps(archive)).toEqual([]);
  });
});

describe('pruning 组合评估（evaluate_org_archive）', () => {
  it('输出顺序不违反 kind 序；确定性 + 纯函数（不改动档案）', () => {
    const archive = new OrgArchive();
    ingest_many(archive, Array.from({ length: 8 }, (_, i) => relay(`relay${i}`)));
    ingest_many(archive, Array.from({ length: 6 }, (_, i) => delegate(`fail${i}`, 'failure')));
    const before = archive.to_dict();
    const first = evaluate_org_archive(archive);
    const second = evaluate_org_archive(archive);
    expect(first.length).toBeGreaterThan(0);
    const rank = ['shortcut', 'downrank', 'retire', 'keep'];
    const ranks = first.map((p) => rank.indexOf(p.kind));
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
    }
    expect(second).toEqual(first);
    expect(archive.to_dict()).toEqual(before);
  });

  it('同 kind 多条按置信度降序', () => {
    const archive = new OrgArchive();
    // main→planner 失败 16 次（置信度 2/3），main→critic 失败 8 次（1/2）
    ingest_many(archive, Array.from({ length: 16 }, (_, i) => delegate(`p${i}`, 'failure')));
    ingest_many(
      archive,
      Array.from({ length: 8 }, (_, i) =>
        trail({
          run_id: `c${i}`,
          parent_run_id: null,
          entry_scope: 'main',
          hops: [{ from: 'main', to: 'critic', shape: 'delegate' }],
          outcome: 'failure',
        })),
    );
    const downranks = suggest_downranks(archive);
    expect(downranks).toHaveLength(2);
    expect(downranks[0]!.mode.to).toBe('planner');
    expect(downranks[1]!.mode.to).toBe('critic');
    expect(downranks[0]!.confidence).toBeGreaterThan(downranks[1]!.confidence);
  });
});
