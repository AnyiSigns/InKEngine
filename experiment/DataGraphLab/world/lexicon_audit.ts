/**
 * 文法自检（T1 的“金标权威性”护栏，非运行期逻辑）。
 *
 * 三类违规必须为零，否则 follow 族往返不可靠：
 * 1) 义项覆盖：op/terminal 每算子 ≥3 个非空义项，且只覆盖 LEX_OPS_BASE；
 * 2) 无严格包含：任一义项不得是另一义项的 token 连续子序列，否则一个短语会命中
 *    两个算子，解析顺序错乱；
 * 3) 歧义类型可判定：同一义项被多个算子共享时，这些算子的 requires 类型必须互斥。
 */

import { GOAL_LEX, GOAL_TEMPLATES, LEXICON, RECIPE_CONNECTORS, RECIPE_PREFIXES } from './lexicon.js';
import { contractOf, LEX_OPS_BASE, requiresTypes } from './operators.js';
import { findSequence, senseTokens, tokens } from './tokenize.js';

export interface Lexeme {
  opId: string;
  sense: string;
}

export function allLexemes(): Lexeme[] {
  const out: Lexeme[] = [];
  for (const opId of LEX_OPS_BASE) {
    for (const sense of LEXICON[opId] ?? []) out.push({ opId, sense });
  }
  return out;
}

function typeSet(opId: string): Set<string> {
  const c = contractOf(opId);
  return new Set(c ? requiresTypes(c) : []);
}

function disjoint(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return false;
  return true;
}

export function validateLexicon(): string[] {
  const v: string[] = [];
  const lexemes = allLexemes();

  for (const opId of LEX_OPS_BASE) {
    const senses = LEXICON[opId];
    if (!senses || senses.length < 3) {
      v.push(`lexicon: ${opId} has ${senses?.length ?? 0} senses (<3)`);
      continue;
    }
    if (senses.some((s) => s.trim() === '')) v.push(`lexicon: ${opId} has empty sense`);
  }
  for (const id of Object.keys(LEXICON)) {
    if (!LEX_OPS_BASE.includes(id)) v.push(`lexicon: ${id} is not an op/terminal id`);
  }

  for (const a of lexemes) {
    for (const b of lexemes) {
      if (a.opId === b.opId && a.sense === b.sense) continue;
      if (a.sense === b.sense) continue; // 共享义项单列（要求类型互斥）
      const ta = senseTokens(a.sense);
      const tb = senseTokens(b.sense);
      if (ta.length < tb.length && findSequence(tb, ta) >= 0) {
        v.push(`containment: "${a.sense}" (${a.opId}) inside "${b.sense}" (${b.opId})`);
      }
    }
  }

  const bySense = new Map<string, Set<string>>();
  for (const l of lexemes) {
    let ops = bySense.get(l.sense);
    if (!ops) {
      ops = new Set<string>();
      bySense.set(l.sense, ops);
    }
    ops.add(l.opId);
  }
  for (const [sense, ops] of bySense) {
    const ids = [...ops];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (!disjoint(typeSet(ids[i]!), typeSet(ids[j]!))) {
          v.push(`ambiguous: "${sense}" shared by ${ids[i]} and ${ids[j]} with overlapping types`);
        }
      }
    }
  }

  // 方向是刻意的：只保证“算子义项不出现在目标/连接词文本里”。反向（GOAL_LEX 词作为
  // LEXICON 义项的连续子序列，如「长度」⊂「取长度」）允许存在——目标词是共享词汇，
  // 只喂 goal_hint 特征、不参与 follow 解析，不构成往返漂移。
  const noOpSense = (text: string, where: string): void => {
    const toks = tokens(text);
    for (const l of lexemes) {
      if (findSequence(toks, senseTokens(l.sense)) >= 0) {
        v.push(`goal/connector leak: "${l.sense}" (${l.opId}) in ${where} "${text}"`);
      }
    }
  };
  for (const list of Object.values(GOAL_TEMPLATES)) {
    for (const t of list) noOpSense(t, 'goal template');
  }
  for (const w of Object.values(GOAL_LEX)) {
    for (const s of w) noOpSense(s, 'goal word');
  }
  for (const c of RECIPE_CONNECTORS) noOpSense(c, 'recipe connector');
  for (const p of RECIPE_PREFIXES) noOpSense(p, 'recipe prefix');

  return v;
}
