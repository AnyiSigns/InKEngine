/**
 * 指令分词与义项命中统计（`tokens` / `mention_stats` 唯一实现）。
 *
 * 分词口径固定：CJK 按字符 bigram（单字 run 退化为单字），ASCII 词按小写词，
 * 可见 ASCII 非词字符各成一 token；CJK/ASCII 标点与空白只作分段、不进 token。
 * 义项匹配是“token 序列的连续子序列精确匹配”，因此跨段不会误命中。
 *
 * `mention_stats` 的 rank 语义：该 op 的首次命中，在全部 LEX_OPS_BASE 算子首次
 * 命中中按先后排第几（0-based）；未命中返回 `LEX_OPS_BASE.length`，使特征恒为 0。
 */

import { LEXICON } from './lexicon.js';
import { LEX_OPS_BASE } from './operators.js';

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}

function isAsciiWord(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    cp === 0x5f // _
  );
}

function isAsciiVisible(cp: number): boolean {
  return cp >= 0x21 && cp <= 0x7e;
}

export function tokens(instr: string): string[] {
  const out: string[] = [];
  const chars = Array.from(instr);
  let cjk: string[] = [];
  let word = '';
  const flushCjk = (): void => {
    for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk[i]! + cjk[i + 1]!);
    if (cjk.length === 1) out.push(cjk[0]!);
    cjk = [];
  };
  const flushWord = (): void => {
    if (word) out.push(word.toLowerCase());
    word = '';
  };
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) {
      flushWord();
      cjk.push(ch);
      continue;
    }
    flushCjk();
    if (isAsciiWord(cp)) {
      word += ch;
      continue;
    }
    flushWord();
    if (isAsciiVisible(cp)) out.push(ch);
  }
  flushCjk();
  flushWord();
  return out;
}

export function senseTokens(sense: string): string[] {
  return tokens(sense);
}

function seqAt(hay: readonly string[], needle: readonly string[], start: number): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (hay[start + i] !== needle[i]) return false;
  }
  return true;
}

/** 连续子序列首次出现的下标，找不到返回 -1。 */
export function findSequence(hay: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > hay.length) return -1;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (seqAt(hay, needle, i)) return i;
  }
  return -1;
}

function countOccurrences(hay: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > hay.length) return 0;
  let n = 0;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (seqAt(hay, needle, i)) n++;
  }
  return n;
}

function sensesOf(key: string | readonly string[]): readonly string[] {
  if (typeof key !== 'string') return key;
  const lex = LEXICON[key];
  return lex ?? [key];
}

function firstIndex(toks: readonly string[], senses: readonly string[]): number {
  let best = -1;
  for (const sense of senses) {
    const i = findSequence(toks, senseTokens(sense));
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

export interface MentionStats {
  /** 该算子全部义项在 token 流中的命中总次数（允许重叠）。 */
  hits: number;
  /** 首次命中下标；未命中 -1。 */
  first: number;
  /** 首次命中的先后序位；未命中为 LEX_OPS_BASE.length。 */
  rank: number;
}

export function mentionStats(toks: readonly string[], key: string | readonly string[]): MentionStats {
  const senses = sensesOf(key);
  let hits = 0;
  for (const sense of senses) hits += countOccurrences(toks, senseTokens(sense));
  const first = firstIndex(toks, senses);
  let rank = LEX_OPS_BASE.length;
  if (typeof key === 'string' && LEXICON[key] && first >= 0) {
    rank = 0;
    for (const opId of LEX_OPS_BASE) {
      if (opId === key) continue;
      const other = firstIndex(toks, sensesOf(opId));
      if (other >= 0 && other < first) rank++;
    }
  }
  return { hits, first, rank };
}

/**
 * 逐位置义项命中组（R7 进度对齐槽与弱扫描共用的唯一实现）：token 流上按义项命中
 * 位置升序，同一位置命中多个算子（共享义项如 `取反` → neg/reverse）同组、组内按
 * LEX_OPS_BASE 序；**枚举义项全部命中位置**（同一义项重复渲染 → 重复占位），
 * 与 `countOccurrences` 同源（允许重叠）。与 `weakLexicalPlan` 的还原口径逐字
 * 同构：弱扫描组内取最小序位即动作计划（含重复算子 → 计划更长、可回放重复步）。
 */
export function occurrencePlan(toks: readonly string[]): readonly (readonly number[])[] {
  const byFirst = new Map<number, number[]>();
  for (let k = 0; k < LEX_OPS_BASE.length; k++) {
    for (const sense of LEXICON[LEX_OPS_BASE[k]!]!) {
      const st = senseTokens(sense);
      if (st.length === 0 || st.length > toks.length) continue;
      for (let i = 0; i + st.length <= toks.length; i++) {
        if (!seqAt(toks, st, i)) continue;
        const group = byFirst.get(i) ?? [];
        if (!group.includes(k)) group.push(k);
        byFirst.set(i, group);
      }
    }
  }
  return [...byFirst.keys()].sort((a, b) => a - b).map((pos) => byFirst.get(pos)!);
}
