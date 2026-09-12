/**
 * 圆桌收敛判据单测（convergence.ts，设计稿 §7.4.3）。
 *
 * 测什么：
 * 1. digest 实质指纹——规范化全等（乱序/seq 漂移不影响）与实质变化可区分；
 * 2. 收敛三判据——digest 全等 → no_new_substantive；≥k 方确认（去重 owner、
 *    内容或结论值带确认标记）→ confirmed_by_k；round ≥ rounds_cap 仍无信号 →
 *    rounds_exhausted（converged=false = 停止加轮移交 main，非共识）；
 * 3. 判据优先序——触顶轮上的正向判据（digest 全等/确认）仍优先于触顶；
 * 4. 空输入零漂移与配置缺省（rounds_cap=8 / confirm_k=2，非法配置回退缺省）。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIRM_K,
  DEFAULT_ROUNDS_CAP,
  confirmers,
  judge_round,
  opinions_digest,
  type OpinionEntry,
} from '../../../src/loop/collab/index.js';

function op(over: Partial<OpinionEntry>): OpinionEntry {
  return { owner: 'c1', content: '', seq: 1, ...over };
}

describe('digest 实质指纹（无新实质意见 = 规范化 digest 与上一轮全等）', () => {
  it('同实质意见乱序/seq 漂移 → digest 全等（seq 是簿记不是实质）', () => {
    const a = opinions_digest([op({ owner: 'c1', content: '采用方案Ａ', seq: 1 }), op({ owner: 'c2', content: '反对', seq: 2 })]);
    const b = opinions_digest([op({ owner: 'c2', content: '反对', seq: 9 }), op({ owner: 'c1', content: '采用 方案A', seq: 4 })]);
    expect(a).toBe(b);
  });

  it('实质变化（新意见/内容变化）→ digest 变化', () => {
    const a = opinions_digest([op({ owner: 'c1', content: '方案一可行' })]);
    const b = opinions_digest([op({ owner: 'c1', content: '方案一可行' }), op({ owner: 'c2', content: '补充成本数据' })]);
    expect(a).not.toBe(b);
  });
});

describe('收敛三判据（§7.4.3：无新实质意见 / ≥k 方确认 / R 轮耗尽）', () => {
  it('digest 全等 → 收敛 no_new_substantive（converged=true）', () => {
    const round = [op({ owner: 'c1', content: '维持原意见' })];
    const verdict = judge_round(opinions_digest(round), round, { round: 2 });
    expect(verdict).toEqual({ converged: true, reason: 'no_new_substantive' });
  });

  it('有新实质意见且无人确认 → ongoing（圆桌继续）', () => {
    const verdict = judge_round('旧轮digest', [op({ owner: 'c1', content: '新的实质意见' })], { round: 2 });
    expect(verdict).toEqual({ converged: false, reason: 'ongoing' });
  });

  it('≥k 方确认（去重 owner）→ 收敛 confirmed_by_k；同 owner 重复确认不重复计', () => {
    const verdict = judge_round(null, [
      op({ owner: 'c1', content: '同意，确认结论', seq: 1 }),
      op({ owner: 'c1', content: '再确认一次', seq: 2 }),
      op({ owner: 'c2', content: '同意', seq: 3 }),
    ]);
    expect(verdict).toEqual({ converged: true, reason: 'confirmed_by_k' });
  });

  it('确认标记可落在显式结论值（verdict/stance）上', () => {
    const verdict = judge_round(null, [
      op({ owner: 'c1', content: '正文', verdict: '同意' }),
      op({ owner: 'c2', content: '正文', stance: '认可' }),
    ]);
    expect(verdict).toEqual({ converged: true, reason: 'confirmed_by_k' });
  });

  it('confirm_k 可配置：k=1 时单人确认即收敛', () => {
    const verdict = judge_round(null, [op({ owner: 'c1', content: '同意' })], { confirm_k: 1 });
    expect(verdict).toEqual({ converged: true, reason: 'confirmed_by_k' });
  });

  it('round ≥ rounds_cap 仍无信号 → 触顶不收敛（停止加轮移交 main，非共识）', () => {
    const verdict = judge_round('旧轮digest', [op({ owner: 'c1', content: '仍有分歧' })], { round: 8, rounds_cap: 8 });
    expect(verdict).toEqual({ converged: false, reason: 'rounds_exhausted' });
  });

  it('触顶轮上正向判据仍优先：digest 全等在 cap 轮照常自然收敛', () => {
    const round = [op({ owner: 'c1', content: '维持' })];
    const verdict = judge_round(opinions_digest(round), round, { round: 8, rounds_cap: 8 });
    expect(verdict).toEqual({ converged: true, reason: 'no_new_substantive' });
  });
});

describe('空输入零漂移与缺省配置', () => {
  it('空意见清单：无上一轮 → ongoing；有全等空 digest → 无新实质收敛', () => {
    expect(judge_round(null, [], { round: 3 })).toEqual({ converged: false, reason: 'ongoing' });
    expect(judge_round('', [], {})).toEqual({ converged: true, reason: 'no_new_substantive' });
    expect(confirmers([])).toEqual([]);
  });

  it('缺省 rounds_cap=8 / confirm_k=2；非法配置值回退缺省（不越界不炸）', () => {
    expect(DEFAULT_ROUNDS_CAP).toBe(8);
    expect(DEFAULT_CONFIRM_K).toBe(2);
    expect(judge_round('旧', [op({ owner: 'c1', content: 'x' })], { round: 7 })).toEqual({ converged: false, reason: 'ongoing' });
    expect(judge_round('旧', [op({ owner: 'c1', content: 'x' })], { round: 8 })).toEqual({ converged: false, reason: 'rounds_exhausted' });
    expect(judge_round('旧', [op({ owner: 'c1', content: '同意' })], { confirm_k: -1 })).toEqual({ converged: false, reason: 'ongoing' });
    expect(judge_round('旧', [op({ owner: 'c1', content: '同意' }), op({ owner: 'c2', content: '同意' })], { confirm_k: -1 })).toEqual({
      converged: true,
      reason: 'confirmed_by_k',
    });
  });
});
