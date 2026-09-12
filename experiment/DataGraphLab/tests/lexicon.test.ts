import { describe, expect, it } from 'vitest';

import { LEX_OPS_BASE } from '../world/operators.js';
import { LEXICON } from '../world/lexicon.js';
import { allLexemes, validateLexicon } from '../world/lexicon_audit.js';
import { mentionStats, senseTokens, tokens } from '../world/tokenize.js';

describe('world/lexicon', () => {
  it('文法自检零违规（覆盖 / 无严格包含 / 歧义类型可判定 / goal 无算子义项）', () => {
    expect(validateLexicon()).toEqual([]);
  });

  it('op/terminal 每算子 ≥3 义项', () => {
    for (const id of LEX_OPS_BASE) {
      expect(LEXICON[id]?.length ?? 0).toBeGreaterThanOrEqual(3);
    }
  });

  it('存在跨 Int/Str 的共享义项且可用类型消歧', () => {
    const shared = new Map<string, Set<string>>();
    for (const l of allLexemes()) {
      const s = shared.get(l.sense) ?? new Set<string>();
      s.add(l.opId);
      shared.set(l.sense, s);
    }
    const ambiguous = [...shared.entries()].filter(([, ops]) => ops.size > 1);
    expect(ambiguous.length).toBeGreaterThanOrEqual(1);
    const hasCrossType = ambiguous.some(
      ([, ops]) => ops.has('neg') && ops.has('reverse'),
    );
    expect(hasCrossType).toBe(true);
  });

  it('mention_stats 接受 op_id 或义项列表，且 rank 语义固定', () => {
    const toks = tokens('加三，然后翻倍，接着减一');
    expect(mentionStats(toks, 'add3')).toEqual({ hits: 1, first: 0, rank: 0 });
    expect(mentionStats(toks, 'mul2')).toEqual({ hits: 1, first: 3, rank: 1 });
    expect(mentionStats(toks, 'check_parity')).toEqual({
      hits: 0,
      first: -1,
      rank: LEX_OPS_BASE.length,
    });
    expect(mentionStats(toks, ['翻倍', '乘以二']).first).toBe(3);
  });

  it('义项 token 化带 bigram（单字退化为单字）', () => {
    expect(senseTokens('乘以二')).toEqual(['乘以', '以二']);
    expect(senseTokens('再')).toEqual(['再']);
  });
});
